import path from 'node:path'
import fs from 'node:fs'
import dotenv from 'dotenv'
import { Client } from 'pg'
import { z } from 'zod'

dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const Unit = z.enum(['piece', 'kg', 'gram', 'litre', 'ml', 'metre', 'box', 'pack', 'set', 'pair'])
const Row = z.object({
  name: z.string().trim().min(1),
  brand: z.string().trim().min(1).nullable().optional(),
  category: z.string().trim().min(1),
  subcategory: z.string().trim().min(1).nullable().optional(),
  packSize: z.number().positive().nullable().optional(),
  unit: Unit,
  sellUnit: Unit.default('piece'),
  barcode: z.string().regex(/^\d{8,14}$/).nullable().optional(),
  aliases: z.array(z.string().trim().min(1)).default([]),
  source: z.string().trim().min(1).nullable().optional(),
  verifiedAt: z.string().datetime().nullable().optional(),
})

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main() {
  const region = arg('region')
  if (region !== 'IN' && region !== 'INTL') throw new Error('Use --region IN or --region INTL')
  const file = path.resolve(process.cwd(), arg('file') ?? (region === 'IN'
    ? 'data/master-items/india-general-store.json'
    : 'data/master-items/international-general-store.json'))
  if (!fs.existsSync(file)) throw new Error(`Master item seed file not found: ${file}`)

  const rows = z.array(Row).parse(JSON.parse(fs.readFileSync(file, 'utf8')))
  const identities = rows.map((row) => [region, row.name, row.brand ?? '', row.packSize ?? '', row.unit].join('|').toLocaleLowerCase())
  if (new Set(identities).size !== identities.length) throw new Error('Seed contains duplicate master-item identities')
  if (process.argv.includes('--check')) {
    console.log(`Validated ${rows.length} ${region} master items from ${path.relative(process.cwd(), file)}`)
    return
  }
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required; this admin-only seed must not use RLS_DATABASE_URL')
  const client = new Client({ connectionString: databaseUrl, application_name: 'ambel-master-item-seed' })
  await client.connect()
  try {
    await client.query('begin')
    const columns = '(region, canonical_name, brand, category, subcategory, pack_size, unit, sell_unit, barcode, aliases, source, verified_at)'
    const insertValues = (batch: typeof rows) => batch.map((_, index) => {
      const offset = index * 12
      return `(${Array.from({ length: 12 }, (_value, valueIndex) => `$${offset + valueIndex + 1}`).join(',')})`
    }).join(',')
    for (let start = 0; start < rows.length; start += 250) {
      const batch = rows.slice(start, start + 250)
      const parameters = batch.flatMap((row) => [
        region, row.name, row.brand ?? null, row.category, row.subcategory ?? null,
        row.packSize ?? null, row.unit, row.sellUnit, row.barcode ?? null,
        [...new Set(row.aliases.map((alias) => alias.toLocaleLowerCase()))],
        row.source ?? null, row.verifiedAt ?? null,
      ])
      await client.query(
        `insert into public.master_items ${columns}
         values ${insertValues(batch)}
         on conflict (region, canonical_name, brand, pack_size, unit)
         do update set category=excluded.category, subcategory=excluded.subcategory,
           barcode=coalesce(excluded.barcode, master_items.barcode), aliases=excluded.aliases,
           source=coalesce(excluded.source, master_items.source),
           verified_at=coalesce(excluded.verified_at, master_items.verified_at),
           is_active=true, updated_at=now()`,
        parameters,
      )
    }
    await client.query('commit')
    console.log(`Seeded ${rows.length} ${region} master items from ${path.relative(process.cwd(), file)}`)
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    await client.end()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
