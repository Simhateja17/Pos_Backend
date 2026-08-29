-- 0069 — index the variant identity fields used by global/catalog search.
--
-- 0050 indexed product names and SKUs. The global header search also accepts
-- barcode, size, colour and material, all of which use leading-wildcard ILIKE
-- in the product fallback query. Trigram GIN indexes keep those searches
-- bounded for larger tenant catalogs.

begin;

CREATE INDEX IF NOT EXISTS idx_variants_barcode_trgm
  ON public.variants USING gin (barcode extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_variants_size_trgm
  ON public.variants USING gin (size extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_variants_color_trgm
  ON public.variants USING gin (color extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_variants_material_trgm
  ON public.variants USING gin (material extensions.gin_trgm_ops);

commit;
