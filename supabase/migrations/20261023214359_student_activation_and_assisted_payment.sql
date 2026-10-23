-- Student activation codes, administrator-assisted password recovery, and assisted-payment audit.
-- Reviewed feature-branch migration; do not apply to production until the full flow is tested.

CREATE TABLE IF NOT EXISTS public.student_access_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.student_records(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('activation', 'password_reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  issued_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS student_access_tokens_student_purpose_idx
  ON public.student_access_tokens(student_id, purpose, created_at DESC);

ALTER TABLE public.student_access_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.student_access_tokens FROM anon, authenticated;
GRANT ALL ON TABLE public.student_access_tokens TO service_role;

ALTER TABLE public.payment_transactions
  ADD COLUMN IF NOT EXISTS initiated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'student_initiated';

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT IF EXISTS payment_transactions_payment_mode_check;
ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_payment_mode_check
  CHECK (payment_mode IN ('student_initiated', 'admin_assisted'));

COMMENT ON TABLE public.student_access_tokens IS
  'Hashed, single-use, expiring codes for student activation and administrator-assisted password recovery. Raw codes are never stored.';
COMMENT ON COLUMN public.payment_transactions.initiated_by_user_id IS
  'Authenticated staff member who initiated an administrator-assisted Paystack payment.';

COMMENT ON COLUMN public.student_records.auth_email IS
  'Internal Supabase Auth sign-in identifier; for students this is a deterministic synthetic identifier, not a student contact email.';
