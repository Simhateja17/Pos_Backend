import { activeStoreId } from '../middleware/storeContext'
import { Router } from 'express'
import { forTenant } from '../db/tenantClient'
import { requireRole } from '../middleware/requireRole'
import {
  CommitImportSchema,
  UploadImportSchema,
  targetFieldsFor,
  type ImportKind,
} from '../contracts/schemas/import'
import { CsvParseError, MAX_FILE_BYTES, decodeCsvBuffer, parseCsvUpload } from '../services/csv-parse'
import { ImportCommitError, commitImport, hashFile } from '../services/import-commit'
import { suggestMapping } from '../services/import-mapping'

const router = Router()

const SAMPLE_ROWS = 10

function toBatchJson(batch: any) {
  // Re-parse from the stored bytes rather than trusting anything a client
  // holds between preview and commit.
  const parsed = parseCsvSafe(batch.source_text)
  const columns = (batch.source_columns as string[]) ?? parsed?.columns ?? []

  return {
    id: batch.id,
    kind: batch.kind as ImportKind,
    fileName: batch.file_name,
    fileHash: batch.file_hash,
    status: batch.status,
    rowCount: batch.row_count,
    columns: columns.map((name) => {
      const values = (parsed?.rows ?? []).map((row) => row[name] ?? '')
      return {
        name,
        samples: values.filter((value) => value !== '').slice(0, 3),
        nonEmptyCount: values.filter((value) => value !== '').length,
      }
    }),
    sampleRows: (parsed?.rows ?? []).slice(0, SAMPLE_ROWS),
    delimiter: parsed?.delimiter ?? ',',
    encoding: parsed?.encoding ?? 'utf-8',
    blankRowsSkipped: parsed?.blankRowsSkipped ?? 0,
    raggedRows: parsed?.raggedRows ?? 0,
    targetFields: targetFieldsFor(batch.kind as ImportKind).map((field) => ({ ...field })),
    committedAt: batch.committed_at?.toISOString() ?? null,
    createdAt: batch.created_at.toISOString(),
    summary: batch.summary ?? null,
  }
}

function parseCsvSafe(text: string) {
  try {
    return parseCsvUpload(Buffer.from(text, 'utf8'))
  } catch {
    return null
  }
}

/** POST /import/uploads — parse a file and stage it for review. Nothing is written to the ledger here. */
router.post('/uploads', requireRole('owner'), async (req, res) => {
  const parsedBody = UploadImportSchema.safeParse(req.body)
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Tell us the file name, what kind of data it is, and send its contents.' })
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(parsedBody.data.contentBase64, 'base64')
  } catch {
    return res.status(400).json({ error: 'That file could not be read.' })
  }
  if (buffer.length === 0) {
    return res.status(400).json({ error: 'That file is empty.' })
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return res.status(413).json({
      error: `That file is larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB limit. Split it and import in parts.`,
    })
  }

  let parsed
  try {
    parsed = parseCsvUpload(buffer)
  } catch (error) {
    if (error instanceof CsvParseError) return res.status(400).json({ error: error.message })
    throw error
  }
  if (parsed.rows.length === 0) {
    return res.status(400).json({ error: 'That file has a header but no rows underneath it.' })
  }

  const fileHash = hashFile(buffer)
  const client = forTenant(req.user!.tenantId) as any

  // Idempotency is enforced by the partial unique index from migration 0024;
  // this lookup exists to give the owner a clear answer, not to be the guard.
  const alreadyCommitted = await client.import_batches.findFirst({
    where: { tenant_id: req.user!.tenantId, file_hash: fileHash, status: 'committed' },
  })
  if (alreadyCommitted) {
    return res.status(409).json({
      error: 'This exact file has already been imported. Importing it again would duplicate that history.',
      batch: toBatchJson(alreadyCommitted),
    })
  }

  const batch = await client.import_batches.create({
    data: {
      tenant_id: req.user!.tenantId,
      kind: parsedBody.data.kind,
      file_name: parsedBody.data.fileName,
      file_hash: fileHash,
      file_size_bytes: buffer.length,
      // Stored decoded, so a Windows-1252 export re-parses identically at commit.
      source_text: decodeCsvBuffer(buffer).text,
      source_columns: parsed.columns as any,
      row_count: parsed.rows.length,
      status: 'pending',
    },
  })

  return res.status(201).json(toBatchJson(batch))
})

router.get('/batches', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const batches = await client.import_batches.findMany({
    orderBy: { created_at: 'desc' },
    take: 25,
  })
  return res.json({ batches: batches.map(toBatchJson) })
})

router.get('/batches/:id', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const batch = await client.import_batches.findFirst({ where: { id: req.params.id } })
  if (!batch) return res.status(404).json({ error: 'That import could not be found.' })
  return res.json(toBatchJson(batch))
})

/**
 * POST /import/batches/:id/mapping-suggestion — ONBOARD-03.
 *
 * Deliberately separate from upload and from commit. The suggestion is
 * returned to the owner and never persisted: only the mapping they confirm on
 * the commit call is written.
 */
router.post('/batches/:id/mapping-suggestion', requireRole('owner'), async (req, res) => {
  const client = forTenant(req.user!.tenantId) as any
  const batch = await client.import_batches.findFirst({ where: { id: req.params.id } })
  if (!batch) return res.status(404).json({ error: 'That import could not be found.' })
  if (batch.status === 'committed') {
    return res.status(409).json({ error: 'That import has already been applied.' })
  }

  const parsed = parseCsvSafe(batch.source_text)
  if (!parsed) return res.status(422).json({ error: 'That file can no longer be parsed.' })

  const suggestion = await suggestMapping({
    kind: batch.kind as ImportKind,
    columns: parsed.columns,
    rows: parsed.rows,
  })

  return res.json(suggestion)
})

/** POST /import/batches/:id/commit — apply the owner-confirmed mapping, all or nothing. */
router.post('/batches/:id/commit', requireRole('owner'), async (req, res) => {
  const parsedBody = CommitImportSchema.safeParse(req.body)
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Send the confirmed column mapping.' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const batch = await client.import_batches.findFirst({ where: { id: req.params.id } })
  if (!batch) return res.status(404).json({ error: 'That import could not be found.' })
  if (batch.status === 'committed') {
    return res.status(409).json({
      error: 'That import has already been applied.',
      batch: toBatchJson(batch),
    })
  }

  try {
    const result = await commitImport({
      tenantId: req.user!.tenantId,
      storeId: activeStoreId(req),
      batchId: batch.id,
      kind: batch.kind as ImportKind,
      fileHash: batch.file_hash,
      sourceText: batch.source_text,
      mappings: parsedBody.data.mappings,
      createdBy: req.actingStaff?.id ?? null,
    })

    const committed = await client.import_batches.findFirst({ where: { id: batch.id } })
    return res.json({ batch: toBatchJson(committed), result })
  } catch (error) {
    if (error instanceof ImportCommitError) {
      return res.status(400).json({ error: error.message })
    }
    // A unique-violation here means a concurrent commit of the same file won
    // the race. The database is the guarantee; this is how it surfaces.
    if ((error as any)?.code === 'P2002') {
      return res.status(409).json({
        error: 'This file was imported by another request just now. Nothing was duplicated.',
      })
    }
    await client.import_batches
      .update({
        where: { id: batch.id },
        data: { status: 'failed', error_message: error instanceof Error ? error.message : 'Unknown error' },
      })
      .catch(() => undefined)
    throw error
  }
})

export default router
