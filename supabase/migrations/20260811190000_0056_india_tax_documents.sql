-- 0056 — India GST document boundary.
--
-- This migration deliberately stops at durable, immutable tax documents. It
-- does not call the IRP, create IRNs/QR codes, or implement E-Way Bills.
-- Those integrations can consume this snapshot later without changing the
-- checkout or return ledger.

BEGIN;

-- The India payment bridge records a UPI payment made outside the POS. It is
-- not a gateway capture or settlement integration.
ALTER TYPE public.payment_method ADD VALUE IF NOT EXISTS 'upi';

-- The plan calls for a configurable prefix/start number. Keep the defaults
-- safe for existing stores; the settings surface can expose these fields in a
-- later plan without changing the document tables.
ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS invoice_prefix text NOT NULL DEFAULT 'INV',
  ADD COLUMN IF NOT EXISTS invoice_start_number bigint NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_invoice_prefix_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_invoice_prefix_check
      CHECK (invoice_prefix ~ '^[A-Za-z0-9]{1,4}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'stores_invoice_start_number_check'
  ) THEN
    ALTER TABLE public.stores
      ADD CONSTRAINT stores_invoice_start_number_check
      CHECK (invoice_start_number > 0);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'tax_document_type'
  ) THEN
    CREATE TYPE public.tax_document_type AS ENUM ('tax_invoice', 'credit_note');
  END IF;
END
$$;

CREATE TABLE public.tax_document_sequences (
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  document_type public.tax_document_type NOT NULL,
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  next_number bigint NOT NULL CHECK (next_number > 0),
  PRIMARY KEY (tenant_id, store_id, document_type, financial_year)
);

CREATE TABLE public.tax_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
  document_type public.tax_document_type NOT NULL,
  financial_year text NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  document_number text NOT NULL CHECK (char_length(document_number) BETWEEN 1 AND 16),
  document_date timestamptz NOT NULL,
  sale_id uuid NOT NULL REFERENCES public.sales(id) ON DELETE RESTRICT,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  return_reference_id uuid,
  original_document_id uuid,
  seller_snapshot jsonb NOT NULL,
  buyer_snapshot jsonb,
  place_of_supply_snapshot jsonb NOT NULL,
  payment_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  discount_total numeric(12,2) NOT NULL DEFAULT 0,
  taxable_total numeric(12,2) NOT NULL DEFAULT 0,
  cgst_total numeric(12,2) NOT NULL DEFAULT 0,
  sgst_total numeric(12,2) NOT NULL DEFAULT 0,
  igst_total numeric(12,2) NOT NULL DEFAULT 0,
  cess_total numeric(12,2) NOT NULL DEFAULT 0,
  rounding_amount numeric(12,2) NOT NULL DEFAULT 0,
  grand_total numeric(12,2) NOT NULL,
  created_by uuid REFERENCES public.staff_members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_documents_sequence_scope_unique
    UNIQUE (tenant_id, store_id, document_type, financial_year, sequence_number),
  CONSTRAINT tax_documents_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tax_documents_original_document_type_check
    CHECK (document_type = 'tax_invoice' AND original_document_id IS NULL
      OR document_type = 'credit_note' AND original_document_id IS NOT NULL),
  CONSTRAINT tax_documents_original_document_fk
    FOREIGN KEY (original_document_id) REFERENCES public.tax_documents(id) ON DELETE RESTRICT,
  CONSTRAINT tax_documents_return_reference_check
    CHECK (document_type = 'credit_note' AND return_reference_id IS NOT NULL
      OR document_type = 'tax_invoice' AND return_reference_id IS NULL)
);

CREATE UNIQUE INDEX tax_documents_tenant_document_number_unique
  ON public.tax_documents (tenant_id, document_number);

CREATE UNIQUE INDEX tax_documents_one_invoice_per_sale
  ON public.tax_documents (tenant_id, sale_id)
  WHERE document_type = 'tax_invoice';

CREATE UNIQUE INDEX tax_documents_one_credit_note_per_return
  ON public.tax_documents (tenant_id, return_reference_id)
  WHERE document_type = 'credit_note';

CREATE INDEX tax_documents_tenant_store_date_idx
  ON public.tax_documents (tenant_id, store_id, document_date DESC);
CREATE INDEX tax_documents_tenant_customer_date_idx
  ON public.tax_documents (tenant_id, customer_id, document_date DESC);
CREATE INDEX tax_documents_original_document_idx
  ON public.tax_documents (tenant_id, original_document_id, document_date DESC);

CREATE TABLE public.tax_document_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.tax_documents(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  sale_line_item_id uuid REFERENCES public.sale_line_items(id) ON DELETE RESTRICT,
  original_line_id uuid REFERENCES public.tax_document_lines(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES public.variants(id) ON DELETE RESTRICT,
  description text NOT NULL,
  sku text,
  hsn_sac text,
  unit text NOT NULL,
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL,
  gross_value numeric(12,2) NOT NULL,
  discount_value numeric(12,2) NOT NULL DEFAULT 0,
  taxable_value numeric(12,2) NOT NULL,
  gst_rate numeric(7,4) NOT NULL DEFAULT 0,
  cgst_amount numeric(12,2) NOT NULL DEFAULT 0,
  sgst_amount numeric(12,2) NOT NULL DEFAULT 0,
  igst_amount numeric(12,2) NOT NULL DEFAULT 0,
  cess_amount numeric(12,2) NOT NULL DEFAULT 0,
  line_total numeric(12,2) NOT NULL,
  CONSTRAINT tax_document_lines_number_unique UNIQUE (document_id, line_number),
  CONSTRAINT tax_document_lines_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tax_document_lines_document_tenant_fk
    FOREIGN KEY (tenant_id, document_id) REFERENCES public.tax_documents(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tax_document_lines_tenant_document_unique UNIQUE (tenant_id, document_id, id)
);

CREATE UNIQUE INDEX tax_document_lines_invoice_line_unique
  ON public.tax_document_lines (document_id, sale_line_item_id)
  WHERE sale_line_item_id IS NOT NULL;
CREATE INDEX tax_document_lines_tenant_idx ON public.tax_document_lines (tenant_id);
CREATE INDEX tax_document_lines_original_line_idx ON public.tax_document_lines (original_line_id);

-- The app role is RLS-protected and only gets append/read access to the
-- immutable documents. The sequence allocator is the only update path.
ALTER TABLE public.tax_document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_document_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_tax_document_sequences ON public.tax_document_sequences
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_tax_documents ON public.tax_documents
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation_tax_document_lines ON public.tax_document_lines
  FOR ALL USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON public.tax_document_sequences TO app_runtime;
GRANT SELECT, INSERT ON public.tax_documents, public.tax_document_lines TO app_runtime;

-- Foreign keys alone cannot prove that two rows belong to the same tenant.
-- This trigger closes that gap for every SQL caller, including future
-- integrations that bypass the current service.
CREATE OR REPLACE FUNCTION public.validate_tax_document_tenant_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sale_tenant uuid;
  sale_store uuid;
  original_tenant uuid;
  original_type public.tax_document_type;
  original_sale uuid;
  customer_tenant uuid;
  document_store_tenant uuid;
BEGIN
  SELECT tenant_id, store_id INTO sale_tenant, sale_store
  FROM public.sales WHERE id = NEW.sale_id;
  IF sale_tenant IS NULL OR sale_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Tax document sale does not belong to the document tenant';
  END IF;

  SELECT tenant_id INTO document_store_tenant
  FROM public.stores WHERE id = NEW.store_id;
  IF document_store_tenant IS NULL OR document_store_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Tax document store does not belong to the document tenant';
  END IF;

  IF NEW.document_type = 'tax_invoice' AND NEW.store_id IS DISTINCT FROM sale_store THEN
    RAISE EXCEPTION 'Tax invoice store must match the sale store';
  END IF;

  IF NEW.original_document_id IS NOT NULL THEN
    SELECT tenant_id, document_type, sale_id INTO original_tenant, original_type, original_sale
    FROM public.tax_documents WHERE id = NEW.original_document_id;
    IF original_tenant IS NULL OR original_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Original tax document does not belong to the document tenant';
    END IF;
    IF original_type IS DISTINCT FROM 'tax_invoice' THEN
      RAISE EXCEPTION 'A credit note must reference a tax invoice';
    END IF;
    IF original_sale IS DISTINCT FROM NEW.sale_id THEN
      RAISE EXCEPTION 'Credit note sale must match the original tax invoice sale';
    END IF;
  END IF;

  IF NEW.customer_id IS NOT NULL THEN
    SELECT tenant_id INTO customer_tenant FROM public.customers WHERE id = NEW.customer_id;
    IF customer_tenant IS NULL OR customer_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Tax document customer does not belong to the document tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_tax_document_tenant_refs
  BEFORE INSERT OR UPDATE ON public.tax_documents
  FOR EACH ROW EXECUTE FUNCTION public.validate_tax_document_tenant_refs();

CREATE OR REPLACE FUNCTION public.validate_tax_document_line_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  document_tenant uuid;
  document_sale uuid;
  document_original_id uuid;
  line_tenant uuid;
  line_sale uuid;
  original_line_tenant uuid;
  original_line_document uuid;
  variant_tenant uuid;
BEGIN
  SELECT tenant_id, sale_id, original_document_id
    INTO document_tenant, document_sale, document_original_id
  FROM public.tax_documents WHERE id = NEW.document_id;
  IF document_tenant IS NULL OR document_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Tax document line does not belong to the document tenant';
  END IF;

  IF NEW.sale_line_item_id IS NOT NULL THEN
    SELECT tenant_id, sale_id INTO line_tenant, line_sale
    FROM public.sale_line_items WHERE id = NEW.sale_line_item_id;
    IF line_tenant IS NULL OR line_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Tax document line sale reference does not belong to the document tenant';
    END IF;
    IF line_sale IS DISTINCT FROM document_sale THEN
      RAISE EXCEPTION 'Tax document line sale reference does not belong to the document sale';
    END IF;
  END IF;

  IF NEW.original_line_id IS NOT NULL THEN
    SELECT tenant_id, document_id INTO original_line_tenant, original_line_document
    FROM public.tax_document_lines WHERE id = NEW.original_line_id;
    IF original_line_tenant IS NULL OR original_line_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Original tax document line does not belong to the document tenant';
    END IF;
    IF document_original_id IS NULL OR original_line_document IS DISTINCT FROM document_original_id THEN
      RAISE EXCEPTION 'Credit note line must reference a line from its original invoice';
    END IF;
  END IF;

  IF NEW.variant_id IS NOT NULL THEN
    SELECT tenant_id INTO variant_tenant FROM public.variants WHERE id = NEW.variant_id;
    IF variant_tenant IS NULL OR variant_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Tax document line variant does not belong to the document tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_tax_document_line_refs
  BEFORE INSERT OR UPDATE ON public.tax_document_lines
  FOR EACH ROW EXECUTE FUNCTION public.validate_tax_document_line_refs();

-- Locking the sequence row and incrementing it in one statement makes number
-- allocation safe across simultaneous registers. The update rolls back with
-- the surrounding document transaction, so failed document creation does not
-- burn a number.
CREATE OR REPLACE FUNCTION public.allocate_tax_document_sequence(
  p_tenant_id uuid,
  p_store_id uuid,
  p_document_type public.tax_document_type,
  p_financial_year text,
  p_start_number bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  allocated bigint;
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '')::uuid IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'Tax document sequence tenant mismatch';
  END IF;
  IF p_start_number < 1 THEN
    RAISE EXCEPTION 'Tax document sequence must start at a positive number';
  END IF;

  INSERT INTO public.tax_document_sequences (
    tenant_id, store_id, document_type, financial_year, next_number
  ) VALUES (
    p_tenant_id, p_store_id, p_document_type, p_financial_year, p_start_number + 1
  )
  ON CONFLICT (tenant_id, store_id, document_type, financial_year)
  DO UPDATE SET next_number = public.tax_document_sequences.next_number + 1
  RETURNING next_number - 1 INTO allocated;

  RETURN allocated;
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_tax_document_sequence(uuid, uuid, public.tax_document_type, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_tax_document_sequence(uuid, uuid, public.tax_document_type, text, bigint)
  TO app_runtime;

REVOKE ALL ON FUNCTION public.validate_tax_document_tenant_refs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_tax_document_line_refs() FROM PUBLIC, anon, authenticated;

COMMIT;
