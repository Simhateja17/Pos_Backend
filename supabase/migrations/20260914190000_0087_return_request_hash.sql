-- 0087 — bind each new return reference to its immutable request.
--
-- Credit-note return_reference_id uniqueness already prevents duplicate
-- refunds. This hash additionally makes changed line quantities, shift,
-- reason or tender data an explicit conflict. Historical documents remain
-- nullable for rolling compatibility.

ALTER TABLE public.tax_documents
  ADD COLUMN request_hash text,
  ADD CONSTRAINT tax_documents_request_hash_format_check CHECK (
    request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'
  );

CREATE FUNCTION public.lock_tax_document_request_authority()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.return_reference_id IS DISTINCT FROM NEW.return_reference_id
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash THEN
    RAISE EXCEPTION 'tax document request authority is immutable';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.lock_tax_document_request_authority() FROM PUBLIC;

CREATE TRIGGER trg_lock_tax_document_request_authority
BEFORE UPDATE OF return_reference_id, request_hash
ON public.tax_documents
FOR EACH ROW EXECUTE FUNCTION public.lock_tax_document_request_authority();
