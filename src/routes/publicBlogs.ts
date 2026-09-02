import { Router } from 'express'
import { backendAdminRegion, queryAdminRows, queryAdminSingle } from '../services/adminStore'

const router = Router()
const publicColumns = 'id,slug,title,excerpt,body,category,author_name,cover_image_url,seo_title,seo_description,published_at,updated_at'

router.get('/', async (_req, res) => {
  const posts = await queryAdminRows<Record<string, unknown>>('blog_posts', (query) =>
    query.select(publicColumns).eq('region', backendAdminRegion()).eq('status', 'published').lte('published_at', new Date().toISOString()).order('published_at', { ascending: false }),
  )
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400').json({ posts })
})

router.get('/:slug', async (req, res) => {
  const slug = String(req.params.slug ?? '')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return res.status(400).json({ error: 'Invalid blog slug' })
  const post = await queryAdminSingle<Record<string, unknown>>('blog_posts', (query) =>
    query.select(publicColumns).eq('region', backendAdminRegion()).eq('status', 'published').eq('slug', slug).lte('published_at', new Date().toISOString()),
  )
  if (!post) return res.status(404).json({ error: 'Blog post not found' })
  res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400').json({ post })
})

export default router
