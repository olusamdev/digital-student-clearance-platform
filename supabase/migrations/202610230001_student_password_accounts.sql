-- Student password authentication and auditable payment identity.
-- Apply through the normal reviewed migration workflow; this file does not run itself.

ALTER TABLE public.student_records
  ADD COLUMN IF NOT EXISTS auth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS auth_email text,
  ADD COLUMN IF NOT EXISTS account_setup_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS recovery_email text,
  ADD COLUMN IF NOT EXISTS recovery_email_verified_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS student_records_auth_user_id_key
  ON public.student_records(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS student_records_auth_email_key
  ON public.student_records(auth_email)
  WHERE auth_email IS NOT NULL;

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS registration_number_snapshot text;

UPDATE public.payment_transactions pt
SET registration_number_snapshot = sr.registration_number
FROM public.session_students ss
JOIN public.student_records sr ON sr.id = ss.student_id
WHERE pt.session_student_id = ss.id
  AND pt.registration_number_snapshot IS NULL;

CREATE INDEX IF NOT EXISTS payment_transactions_registration_snapshot_idx
  ON public.payment_transactions(registration_number_snapshot);

COMMENT ON COLUMN public.student_records.auth_user_id IS
  'Student-owned Supabase Auth identity; set only by trusted server-side account setup.';
COMMENT ON COLUMN public.student_records.auth_email IS
  'Internal synthetic Auth email used for password sign-in; never displayed to students.';
COMMENT ON COLUMN public.payment_transactions.registration_number_snapshot IS
  'Registration number captured at payment creation for durable reconciliation and audit.';
