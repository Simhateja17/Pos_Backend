import { describe, expect, it } from 'vitest'
import { AdminBlogPostSchema } from '../../src/contracts/schemas/admin'

const valid = { slug: 'daily-retail-guide', title: 'Daily retail guide', excerpt: 'A useful summary for shop owners.', body: 'Useful article body.', category: 'Retail Ops', authorName: 'Ambel POS Editorial', coverImageUrl: '', seoTitle: '', seoDescription: '', status: 'published' as const }

describe('AdminBlogPostSchema', () => {
  it('accepts a complete publishable regional article', () => expect(AdminBlogPostSchema.safeParse(valid).success).toBe(true))
  it('rejects unsafe or malformed slugs', () => expect(AdminBlogPostSchema.safeParse({ ...valid, slug: '../other-region' }).success).toBe(false))
  it('rejects non-web cover image schemes', () => expect(AdminBlogPostSchema.safeParse({ ...valid, coverImageUrl: 'javascript:alert(1)' }).success).toBe(false))
  it('enforces search-result description length', () => expect(AdminBlogPostSchema.safeParse({ ...valid, seoDescription: 'x'.repeat(171) }).success).toBe(false))
})
