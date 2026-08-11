-- 0056 — bounded India customer profiles.
--
-- Customers remain business-wide records. Store scope belongs to the sale and
-- is applied by the purchase-history read model; adding store_id here would
-- split one customer's identity when they shop at two outlets.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS billing_name text,
  ADD COLUMN IF NOT EXISTS gstin text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS address_line2 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state_code text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'IN',
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Normalize the existing data before rebuilding the identity indexes. The
-- duplicate guards fail the migration loudly rather than silently merging two
-- records or choosing a fuzzy-name winner.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.customers
    WHERE nullif(btrim(phone), '') IS NULL
      AND nullif(btrim(email), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Customer migration found saved profiles without phone or email; repair those rows before applying 0056';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT tenant_id, lower(btrim(email)) AS normalized_email, count(*)
      FROM public.customers
      WHERE email IS NOT NULL AND btrim(email) <> ''
      GROUP BY tenant_id, lower(btrim(email))
      HAVING count(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Customer migration found duplicate tenant-scoped emails after normalization; resolve them before applying 0056';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT tenant_id,
        CASE
          WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
            THEN '+91' || regexp_replace(phone, '[^0-9]', '', 'g')
          WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
            AND left(regexp_replace(phone, '[^0-9]', '', 'g'), 1) = '0'
            THEN '+91' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
          WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 12
            AND left(regexp_replace(phone, '[^0-9]', '', 'g'), 2) = '91'
            THEN '+' || regexp_replace(phone, '[^0-9]', '', 'g')
          WHEN left(regexp_replace(phone, '[^0-9]', '', 'g'), 2) = '00'
            THEN '+' || substring(regexp_replace(phone, '[^0-9]', '', 'g') from 3)
          ELSE '+' || regexp_replace(phone, '[^0-9]', '', 'g')
        END AS normalized_phone,
        count(*)
      FROM public.customers
      WHERE phone IS NOT NULL AND btrim(phone) <> ''
      GROUP BY tenant_id, normalized_phone
      HAVING count(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Customer migration found duplicate tenant-scoped phones after normalization; resolve them before applying 0056';
  END IF;
END
$$;

UPDATE public.customers
SET email = NULLIF(lower(btrim(email)), '')
WHERE email IS NOT NULL;

UPDATE public.customers
SET phone = CASE
  WHEN phone IS NULL OR btrim(phone) = '' THEN NULL
  WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
    THEN '+91' || regexp_replace(phone, '[^0-9]', '', 'g')
  WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
    AND left(regexp_replace(phone, '[^0-9]', '', 'g'), 1) = '0'
    THEN '+91' || right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
  WHEN length(regexp_replace(phone, '[^0-9]', '', 'g')) = 12
    AND left(regexp_replace(phone, '[^0-9]', '', 'g'), 2) = '91'
    THEN '+' || regexp_replace(phone, '[^0-9]', '', 'g')
  WHEN left(regexp_replace(phone, '[^0-9]', '', 'g'), 2) = '00'
    THEN '+' || substring(regexp_replace(phone, '[^0-9]', '', 'g') from 3)
  ELSE '+' || regexp_replace(phone, '[^0-9]', '', 'g')
END
WHERE phone IS NOT NULL;

UPDATE public.customers
SET billing_name = NULLIF(btrim(name), '')
WHERE billing_name IS NULL;

UPDATE public.customers
SET country = upper(COALESCE(NULLIF(btrim(country), ''), 'IN'))
WHERE country IS DISTINCT FROM upper(COALESCE(NULLIF(btrim(country), ''), 'IN'));

DROP INDEX IF EXISTS public.idx_customers_tenant_phone;
DROP INDEX IF EXISTS public.idx_customers_tenant_email;

CREATE UNIQUE INDEX idx_customers_tenant_phone
  ON public.customers (tenant_id, phone)
  WHERE phone IS NOT NULL;

CREATE UNIQUE INDEX idx_customers_tenant_email
  ON public.customers (tenant_id, lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_tenant_updated_at
  ON public.customers (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_customers_tenant_billing_name
  ON public.customers (tenant_id, lower(billing_name));

CREATE INDEX IF NOT EXISTS idx_customers_tenant_gstin
  ON public.customers (tenant_id, gstin)
  WHERE gstin IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_identity_present_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_identity_present_check
      CHECK (
        nullif(btrim(phone), '') IS NOT NULL OR
        nullif(btrim(email), '') IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_gstin_format_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_gstin_format_check
      CHECK (
        gstin IS NULL OR
        gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_state_code_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_state_code_check
      CHECK (state_code IS NULL OR state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_postal_code_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_postal_code_check
      CHECK (postal_code IS NULL OR postal_code ~ '^[1-9][0-9]{5}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_country_code_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_country_code_check
      CHECK (country ~ '^[A-Z]{2}$');
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.touch_customers_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_touch_updated_at ON public.customers;
CREATE TRIGGER customers_touch_updated_at
BEFORE UPDATE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.touch_customers_updated_at();

-- Re-assert the default-deny tenant policy after the profile expansion. The
-- NULLIF matters on pooled connections whose transaction-local setting resets
-- to an empty string after forTenant() returns its connection.
ALTER POLICY tenant_isolation_customers ON public.customers
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO app_runtime;
