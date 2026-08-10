import { describe, expect, it, vi } from 'vitest'
import { buildReport } from '../../src/routes/reports'

describe('report SQL stays aligned with the category schema', () => {
  it('resolves category labels through categories instead of the removed products.category column', async () => {
    const queryRawUnsafe = vi.fn().mockResolvedValue([])

    await buildReport(
      { $queryRawUnsafe: queryRawUnsafe },
      {
        kind: 'sales-by-category',
        storeId: null,
      tenantId: '11111111-1111-4111-8111-111111111111',
        zone: 'UTC',
        from: '2026-08-01',
        to: '2026-08-07',
        includeImported: true,
      },
    )

    const sql = String(queryRawUnsafe.mock.calls[0][0])
    expect(sql).toContain("coalesce(c.name, 'Uncategorised')")
    expect(sql).toContain('left join categories c on c.id = p.category_id')
    expect(sql).not.toMatch(/\bp\.category\b/)
  })
})
