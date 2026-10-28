BEGIN;

-- Receipt files are stored in a private bucket. Only the bursary-receipts
-- Edge Function uses the service role to issue short-lived upload/download URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('bursary-receipts', 'bursary-receipts', false, 5242880, ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = false, file_size_limit = 5242880,
    allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png','image/webp'];

CREATE TABLE IF NOT EXISTS public.bursary_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_student_id uuid NOT NULL REFERENCES public.session_students(id) ON DELETE CASCADE,
  clearance_request_id uuid NOT NULL REFERENCES public.clearance_requests(id) ON DELETE CASCADE,
  uploaded_by_student_id uuid NOT NULL REFERENCES public.student_records(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bursary_receipts_session_student_idx
  ON public.bursary_receipts(session_student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bursary_receipts_request_idx
  ON public.bursary_receipts(clearance_request_id, created_at DESC);

ALTER TABLE public.bursary_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bursary_receipts FROM anon, authenticated;
GRANT ALL ON TABLE public.bursary_receipts TO service_role;

COMMIT;
