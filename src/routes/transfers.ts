import { Prisma } from '@prisma/client'
import { Router } from 'express'
import { CreateStockTransferSchema, ReceiveStockTransferSchema } from '../contracts/schemas/transfer'
import { forTenant, forTenantTransaction } from '../db/tenantClient'
import { activeStoreId } from '../middleware/storeContext'

const router = Router()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function actingStaffId(tx: any, req: import('express').Request): Promise<string | null> {
  if (req.actingStaff?.id) return req.actingStaff.id
  const staff = await tx.staff_members.findFirst({
    where: { user_id: req.user!.id, is_active: true },
    select: { id: true },
  })
  return staff?.id ?? null
}

async function loadTransfer(client: any, id: string) {
  const transfer = await client.stock_transfers.findFirst({ where: { id } })
  if (!transfer) return null
  const lines = await client.stock_transfer_lines.findMany({
    where: { transfer_id: id },
    orderBy: { id: 'asc' },
  })
  const [stores, variants] = await Promise.all([
    client.stores.findMany({ where: { id: { in: [transfer.from_store_id, transfer.to_store_id] } } }),
    client.variants.findMany({
      where: { id: { in: lines.map((line: any) => line.variant_id) } },
      select: { id: true, sku: true },
    }),
  ])
  const storeNames = new Map(stores.map((store: any) => [store.id, store.name]))
  const skus = new Map(variants.map((variant: any) => [variant.id, variant.sku]))
  return {
    id: transfer.id,
    clientTransferId: transfer.client_transfer_id,
    clientReceiveId: transfer.client_receive_id ?? null,
    fromStoreId: transfer.from_store_id,
    fromStoreName: storeNames.get(transfer.from_store_id) ?? '',
    toStoreId: transfer.to_store_id,
    toStoreName: storeNames.get(transfer.to_store_id) ?? '',
    status: transfer.status,
    note: transfer.note,
    sentAt: transfer.sent_at.toISOString(),
    receivedAt: transfer.received_at?.toISOString() ?? null,
    lines: lines.map((line: any) => ({
      id: line.id,
      variantId: line.variant_id,
      sku: skus.get(line.variant_id) ?? '',
      quantitySent: line.quantity_sent.toString(),
      quantityReceived: line.quantity_received?.toString() ?? null,
      discrepancy:
        line.quantity_received === null
          ? null
          : new Prisma.Decimal(line.quantity_sent).minus(line.quantity_received).toString(),
    })),
  }
}

router.get('/', async (req, res) => {
  const storeId = activeStoreId(req)
  const client = forTenant(req.user!.tenantId) as any
  const rows = await client.stock_transfers.findMany({
    where: { OR: [{ from_store_id: storeId }, { to_store_id: storeId }] },
    orderBy: { sent_at: 'desc' },
    select: { id: true },
  })
  const transfers = await Promise.all(rows.map((row: any) => loadTransfer(client, row.id)))
  return res.json(transfers.filter(Boolean))
})

router.get('/destinations', async (req, res) => {
  const sourceStoreId = activeStoreId(req)
  const client = forTenant(req.user!.tenantId) as any
  const stores = await client.stores.findMany({
    where: { is_active: true, id: { not: sourceStoreId } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  return res.json(stores)
})

router.post('/', async (req, res) => {
  const parsed = CreateStockTransferSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid transfer', details: parsed.error.flatten() })

  const tenantId = req.user!.tenantId
  const fromStoreId = activeStoreId(req)
  if (parsed.data.toStoreId === fromStoreId) {
    return res.status(400).json({ error: 'Choose a different destination store' })
  }
  const variantIds = parsed.data.lines.map((line) => line.variantId)
  if (new Set(variantIds).size !== variantIds.length) {
    return res.status(400).json({ error: 'A variant can appear only once in a transfer' })
  }

  try {
    const result = await forTenantTransaction(tenantId, async (tx: any) => {
      const replay = await tx.stock_transfers.findFirst({
        where: { client_transfer_id: parsed.data.clientTransferId },
        select: { id: true },
      })
      if (replay) return { id: replay.id, replayed: true }

      const destination = await tx.stores.findFirst({
        where: { id: parsed.data.toStoreId, is_active: true },
        select: { id: true },
      })
      const variants = await tx.variants.findMany({
        where: { id: { in: variantIds } },
        select: { id: true },
      })
      if (!destination) throw Object.assign(new Error('Destination store not found'), { status: 404 })
      if (variants.length !== variantIds.length) {
        throw Object.assign(new Error('One or more variants were not found'), { status: 404 })
      }

      const createdBy = await actingStaffId(tx, req)
      const transfer = await tx.stock_transfers.create({
        data: {
          tenant_id: tenantId,
          from_store_id: fromStoreId,
          to_store_id: parsed.data.toStoreId,
          client_transfer_id: parsed.data.clientTransferId,
          note: parsed.data.note ?? null,
          created_by: createdBy,
        },
      })
      for (const line of parsed.data.lines) {
        await tx.stock_transfer_lines.create({
          data: {
            tenant_id: tenantId,
            transfer_id: transfer.id,
            variant_id: line.variantId,
            quantity_sent: line.quantitySent,
          },
        })
        await tx.stock_movements.create({
          data: {
            tenant_id: tenantId,
            store_id: fromStoreId,
            variant_id: line.variantId,
            movement_type: 'transfer',
            quantity_delta: -line.quantitySent,
            reference_id: transfer.id,
            created_by: createdBy,
          },
        })
      }
      return { id: transfer.id, replayed: false }
    })
    const transfer = await loadTransfer(forTenant(tenantId) as any, result.id)
    return res.status(result.replayed ? 200 : 201).json(transfer)
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const client = forTenant(tenantId) as any
      const winner = await client.stock_transfers.findFirst({
        where: { client_transfer_id: parsed.data.clientTransferId },
        select: { id: true },
      })
      if (winner) return res.status(200).json(await loadTransfer(client, winner.id))
    }
    const status = Number.isInteger(error?.status) ? error.status : error?.message?.includes('below zero') ? 409 : 500
    return res.status(status).json({ error: status === 500 ? 'Could not send transfer' : error.message })
  }
})

router.post('/:transferId/receive', async (req, res) => {
  if (!UUID_PATTERN.test(req.params.transferId)) return res.status(400).json({ error: 'Invalid transfer id' })
  const parsed = ReceiveStockTransferSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'Invalid receipt', details: parsed.error.flatten() })
  const tenantId = req.user!.tenantId
  const destinationStoreId = activeStoreId(req)
  const lineIds = parsed.data.lines.map((line) => line.transferLineId)
  if (new Set(lineIds).size !== lineIds.length) {
    return res.status(400).json({ error: 'A transfer line can appear only once in a receipt' })
  }

  try {
    const result = await forTenantTransaction(tenantId, async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM public.stock_transfers WHERE id = ${req.params.transferId}::uuid FOR UPDATE`
      const transfer = await tx.stock_transfers.findFirst({ where: { id: req.params.transferId } })
      if (!transfer || transfer.to_store_id !== destinationStoreId) {
        throw Object.assign(new Error('Transfer not found for this destination store'), { status: 404 })
      }
      if (transfer.status === 'received') {
        if (transfer.client_receive_id === parsed.data.clientReceiveId) return { id: transfer.id, replayed: true }
        throw Object.assign(new Error('This transfer has already been received'), { status: 409 })
      }
      if (transfer.status !== 'sent') {
        throw Object.assign(new Error('Only a sent transfer can be received'), { status: 409 })
      }
      const lines = await tx.stock_transfer_lines.findMany({ where: { transfer_id: transfer.id } })
      if (lines.length !== lineIds.length || lines.some((line: any) => !lineIds.includes(line.id))) {
        throw Object.assign(new Error('Count every transfer line before confirming receipt'), { status: 400 })
      }

      const receivedBy = await actingStaffId(tx, req)
      for (const line of lines) {
        const received = parsed.data.lines.find((input) => input.transferLineId === line.id)!
        await tx.stock_transfer_lines.update({
          where: { id: line.id },
          data: { quantity_received: received.quantityReceived },
        })
        if (received.quantityReceived > 0) {
          await tx.stock_movements.create({
            data: {
              tenant_id: tenantId,
              store_id: destinationStoreId,
              variant_id: line.variant_id,
              movement_type: 'transfer',
              quantity_delta: received.quantityReceived,
              reference_id: transfer.id,
              created_by: receivedBy,
            },
          })
        }
      }
      await tx.stock_transfers.update({
        where: { id: transfer.id },
        data: {
          status: 'received',
          client_receive_id: parsed.data.clientReceiveId,
          received_by: receivedBy,
          received_at: new Date(),
        },
      })
      return { id: transfer.id, replayed: false }
    })
    return res.status(result.replayed ? 200 : 201).json(await loadTransfer(forTenant(tenantId) as any, result.id))
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'This receipt request has already been used' })
    }
    const status = Number.isInteger(error?.status) ? error.status : 500
    return res.status(status).json({ error: status === 500 ? 'Could not receive transfer' : error.message })
  }
})

export default router
