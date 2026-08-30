import { Router } from 'express'
import { MasterItemSearchSchema } from '../contracts/schemas/masterItem'
import { forTenant } from '../db/tenantClient'

const router = Router()

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase()
}

function displayName(row: any): string {
  const identity = [row.brand, row.canonical_name].filter(Boolean).join(' ')
  const pack = row.pack_size == null ? '' : ` ${Number(row.pack_size).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${row.unit}`
  return `${identity}${pack}`.trim()
}

router.get('/', async (req, res) => {
  const parsed = MasterItemSearchSchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({ error: 'Type at least 2 characters to search the master catalogue.' })
  }

  const client = forTenant(req.user!.tenantId) as any
  const tenant = await client.tenants.findFirst({ where: { id: req.user!.tenantId }, select: { country: true } })
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' })

  const region = tenant.country === 'IN' ? 'IN' : 'INTL'
  const query = parsed.data.query
  const rows = await client.master_items.findMany({
    where: {
      region,
      is_active: true,
      OR: [
        { canonical_name: { contains: query, mode: 'insensitive' } },
        { brand: { contains: query, mode: 'insensitive' } },
        { category: { contains: query, mode: 'insensitive' } },
        { subcategory: { contains: query, mode: 'insensitive' } },
        { aliases: { has: normalized(query) } },
      ],
    },
    take: Math.min(parsed.data.limit * 3, 60),
  })

  const wanted = normalized(query)
  rows.sort((a: any, b: any) => {
    const score = (row: any) => {
      const name = normalized(row.canonical_name)
      const brand = normalized(row.brand)
      if (name === wanted || `${brand} ${name}`.trim() === wanted) return 0
      if (name.startsWith(wanted) || brand.startsWith(wanted)) return 1
      if ((row.aliases as string[]).some((alias) => normalized(alias) === wanted)) return 2
      return 3
    }
    return score(a) - score(b) || displayName(a).localeCompare(displayName(b))
  })

  return res.json(rows.slice(0, parsed.data.limit).map((row: any) => ({
    id: row.id,
    name: row.canonical_name,
    brand: row.brand,
    category: row.category,
    subcategory: row.subcategory,
    packSize: row.pack_size == null ? null : row.pack_size.toString(),
    packUnit: row.unit,
    sellUnit: row.sell_unit,
    barcode: row.barcode,
    displayName: displayName(row),
  })))
})

export default router
