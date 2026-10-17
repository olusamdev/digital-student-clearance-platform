# Handoff — COHT Digital Student Clearance Platform

## Confirmed requirements
- Taraba State College of Health Technology, Takum; standalone from CBT; do not use Lovable.
- Final-year students only, loaded by College staff.
- Student enters registration number; College-uploaded name and registration number are immutable. Other approved particulars are editable, with dropdowns for controlled fields.
- SuperAdmin-configurable clearance fee; initial value ₦1,700.
- Payment must be verified before clearance offices are available.
- Student requests each applicable office individually; office is notified.
- Each office has a Clear action and a separate comments/remarks action to guide students.
- Remind officers every 24 hours about requests still uncleared and uncommented; keep commented-but-pending requests pending and make any continued reminders configurable.
- Demonstration Unit requirement is configurable by department/programme.
- Provost must assent before Registrar can bulk-print completed clearance forms.
- Certification Office can search/filter Provost-assented cleared students by department; read-only for clearance decisions.
- Audit trail, server-side payment verification, scoped permissions, backups and QR/reference verification required.
- Paystack is the candidate gateway, subject to confirmation of educational pricing and merchant eligibility; test mode first.

## Supabase project and local workspace
- Remote Supabase project: `college clearance form` (`cipsazscgpyoaxwukmaw`), West EU (Ireland).
- Local project folder: `C:\Users\ADMIN\Documents\CodeProjects\Digital Student Clearance Platform`.
- Supabase CLI 2.114.0; remote project linked with `supabase link --project-ref cipsazscgpyoaxwukmaw`.
- Do not use or modify the separate COHT CBT Supabase project (`mywuufgnbxbivrxjllbp`).

## Database status — verified 2026-10-10
- Migration `202610090001_foundation.sql` was successfully applied using `supabase db push`.
- `supabase migration list` showed `202610090001` in both Local and Remote.
- A read-only Supabase SQL Editor check confirmed all 17 expected tables exist and `relrowsecurity = true` for each.
- All 17 tables had zero policies at that verification point. This was intentional for the foundation stage.
- `supabase db lint` could not run because the local Postgres container is not running (`127.0.0.1:54322`); the remote migration itself succeeded. Docker is not required just to continue with remote-only work.

## Migration files
- `supabase/migrations/202610090001_foundation.sql` — foundational schema, enums, helper functions, default fee/settings, RLS enabled.
- `supabase/migrations/202610100001_staff_auth_and_rls.sql` — prepared Phase 2 migration: active-staff role checks, scoped read policies, and SELECT-only client table privileges. It has **not yet been applied remotely**.

## Security status and next steps
- The foundation schema is deployed; the Phase 2 migration is prepared but still needs review and application.
- The Phase 2 migration intentionally gives authenticated clients no direct INSERT/UPDATE/DELETE rights on operational tables. Mutations must be implemented as narrowly scoped, audited RPCs or Edge Functions.
- Staff access relies on Supabase Auth users plus active rows in `staff_profiles` and `staff_role_assignments`. Staff invitation/activation and role management flows still need implementation.
- Student registration-number-only access is not identity proof. Do not enable a public student flow until anti-enumeration, rate limiting, short-lived sessions and audit logging are implemented.
- Do not import real student records, expose a public frontend, or enable live payments yet.
- Next implementation tasks: review/apply Phase 2 migration; add secure staff provisioning and audited decision RPCs; add Provost final-assent RPC; implement student session and payment Edge Functions; then UI, reminders, imports, printable form, QR verification and tests.
