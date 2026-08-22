-- 0061 — counter-bound Hardware Companion control plane.

CREATE TABLE public.hardware_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE, terminal_id uuid NOT NULL REFERENCES public.terminals(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, created_by uuid REFERENCES public.staff_members(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.hardware_companions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE, terminal_id uuid NOT NULL REFERENCES public.terminals(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, machine_name text NOT NULL, os text NOT NULL, version text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb, last_seen_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX hardware_companions_active_terminal ON public.hardware_companions(tenant_id, terminal_id) WHERE revoked_at IS NULL;
CREATE TABLE public.hardware_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE, terminal_id uuid NOT NULL REFERENCES public.terminals(id) ON DELETE CASCADE,
  companion_id uuid REFERENCES public.hardware_companions(id) ON DELETE SET NULL, sale_id uuid REFERENCES public.sales(id) ON DELETE SET NULL,
  kind text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL, error_message text, created_by uuid REFERENCES public.staff_members(id), created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz, completed_at timestamptz,
  CONSTRAINT hardware_jobs_kind_check CHECK (kind IN ('test_print','print_receipt','open_drawer','print_labels','read_scale')),
  CONSTRAINT hardware_jobs_status_check CHECK (status IN ('queued','claimed','completed','failed','cancelled')),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX hardware_jobs_next ON public.hardware_jobs(companion_id, status, created_at) WHERE status IN ('queued','claimed');

ALTER TABLE public.hardware_pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_companions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hardware_jobs ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE table_name text; BEGIN FOREACH table_name IN ARRAY ARRAY['hardware_pairing_codes','hardware_companions','hardware_jobs'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', 'tenant_isolation_' || table_name, table_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_runtime', table_name);
END LOOP; END $$;
