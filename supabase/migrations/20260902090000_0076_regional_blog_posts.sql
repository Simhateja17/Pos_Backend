-- Regional editorial publishing for Ambel POS marketing sites.
-- Each deployment owns only its region's posts; public reads go through the API.
create table if not exists public.blog_posts (
  id uuid primary key default gen_random_uuid(),
  region text not null check (region in ('IN', 'INTL')),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  title text not null check (char_length(title) between 1 and 160),
  excerpt text not null check (char_length(excerpt) between 1 and 320),
  body text not null check (char_length(body) between 1 and 50000),
  category text not null check (char_length(category) between 1 and 80),
  author_name text not null default 'Ambel POS Editorial',
  cover_image_url text,
  seo_title text check (seo_title is null or char_length(seo_title) between 1 and 70),
  seo_description text check (seo_description is null or char_length(seo_description) between 1 and 170),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by uuid references public.platform_admins(id) on delete set null,
  updated_by uuid references public.platform_admins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(region, slug),
  check ((status = 'draft') or published_at is not null)
);

create index if not exists blog_posts_publication_idx
  on public.blog_posts(region, status, published_at desc);

alter table public.blog_posts enable row level security;
revoke all on table public.blog_posts from anon, authenticated;
grant all on table public.blog_posts to service_role;

