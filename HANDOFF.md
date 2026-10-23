# Handoff — COHT Digital Student Clearance Platform

## Current project
- Institution: Taraba State College of Health Technology, Takum.
- GitHub: `olusamdev/digital-student-clearance-platform`, branch `main`.
- Production frontend: `https://dscp.olusamdev.workers.dev` (Cloudflare Worker `dscp`).
- Supabase: `college clearance form`, project ref `cipsazscgpyoaxwukmaw`, West EU/Ireland.
- Local repo: `C:\Users\ADMIN\Documents\CodeProjects\Digital Student Clearance Platform`.
- This is separate from COHT CBT Supabase project `mywuufgnbxbivrxjllbp`. Never cross projects.
- Stack: React 19, Vite 6, TypeScript, Supabase JS, Supabase Edge Functions.
- User wants concise, evidence-based reports; do not use Lovable or coding agents for this project. Do not deploy frontend until the user builds/tests locally and explicitly runs the deployment step.

## Confirmed requirements
- Final-year students only, loaded by College staff.
- Registration number and college-controlled identity fields cannot be edited by students; approved particulars can be confirmed/edited.
- SuperAdmin-configurable clearance fee; initial fee ₦1,700.
- Payment must be server-verified before clearance requests can be submitted.
- Students track each office decision and student-visible remarks.
- Officers can clear requests separately from adding remarks.
- Reminders configurable, initially every 24 hours for unresolved/uncommented requests.
- Demonstration Unit requirements configurable by department/programme.
- Provost Final Assent required before Registrar can print completed clearance register/forms.
- Certification Office read-only for clearance decisions; can search/filter completed, Provost-assented students.
- Audit trail, scoped permissions, payment verification, backups and QR/reference verification required.
- Paystack is the candidate gateway; test mode first. Payment integration is not yet complete.

## Current implementation
- Staff portal: sign-in, staff role checks, staff management, institutional setup, office clearance, Registrar completed register and Provost assent workflow.
- Staff deletion Edge Function deployed and verified active.
- `manage-clearance` and `list-staff` were redeployed with bundled shared CORS and JWT verification; user confirmed staff/Registrar portals work.
- Invitation acceptance flow handles invitation tokens and uses an 8-character frontend minimum. Auth password policy may still impose a higher minimum.
- New dedicated Provost frontend route: `/provost`. It checks the active Provost role and reuses the existing server-validated clearance workflow.
- New student frontend route: `/student`. Uses phone OTP sign-in, displays particulars/session/office status, confirms approved particulars, and submits requests only when the backend says payment is unlocked.
- New `student-portal` Edge Function is deployed ACTIVE, version 1, `verify_jwt=true`. It checks verified phone ownership, rejects staff accounts, matches one unique student record, and performs student operations server-side.
- Student OTP requires Supabase Auth phone/SMS sign-in to be configured. The portal does not accept registration number alone.
- Student portal does not yet offer online payment. It explicitly blocks submission until payment is verified and `session_students.payment_unlocked_at` is set by trusted payment workflow.
- Latest frontend commits on `main` include Provost and Student portal routes/components and navigation. Latest known App commit: `8d56f83bae1dc8c29f4df1c226771f5368a9308f`. Latest student Edge Function source security fix commit: `0f9de6d10f1b13dcb1c2817e3e453601cde5fa1e`.

## Live database status — checked 2026-10-22
Read-only SQL returned:
- `student_records`: 0 rows.
- Active `clearance_sessions`: 0.
- `session_students`: 0.
- Enabled required clearance requirements: 0.
Therefore, student dashboard and Provost queue cannot be tested end-to-end until student records, clearance sessions, session assignments and office requirements are configured/imported.

## Next-session action sequence
1. In the local repo, run `git pull origin main`.
2. Verify the new files exist: `src/components/StudentPortal.tsx`, `src/components/ProvostPortal.tsx`, and `supabase/functions/student-portal/index.ts`.
3. Run `npm run build`; fix any TypeScript/build errors before deploying. No local build has been run from this chat.
4. Enable/configure Supabase Auth phone OTP/SMS and confirm the correct `ALLOWED_ORIGIN` includes `https://dscp.olusamdev.workers.dev`.
5. Import student records; configure active clearance session, applicable requirements, and `session_students` assignments. Check duplicate/missing student phone numbers.
6. Test student OTP using a controlled test student, verify staff accounts cannot use the student route, verify profile confirmation and office-request authorization.
7. Implement and test Paystack initiation, verification/webhook and server-side setting of `payment_unlocked_at`. Do not allow client-supplied payment status.
8. Test Provost assent eligibility and Registrar completed register with controlled records.
9. Only after local build and controlled tests pass, deploy frontend using `npx wrangler deploy`; then verify `/student`, `/provost`, staff portal and Registrar portal on production.
10. Update this handoff after the next work session with actual build/test/deployment results.


## Student-record import system — 2026-10-22
- Added `src/components/StudentImport.tsx` to the SuperAdmin dashboard, gated by the existing active SuperAdmin role.
- Added downloadable CSV UTF-8 template with required columns `registration_number,full_name,department,programme`; optional columns: `phone_number,gender,student_set,admission_year,graduation_year,permanent_address`.
- CSV parser supports quoted commas, escaped quotes and multiline quoted cells; file max 5 MB and 1,000 rows per batch.
- Added `supabase/functions/import-students/index.ts`, deployed to the DSCP project as ACTIVE version 2 with `verify_jwt=true` and shared CORS bundled.
- Server verifies the signed-in active staff profile and SuperAdmin role. It validates department/programme code or name, required fields, gender/year formats, duplicates within the CSV, and existing registration numbers.
- Import does not overwrite existing registration numbers. A valid batch is inserted in one database insert statement; failed insert updates the batch to failed and returns an error report. Successful batches record counts in `import_batches` and add an `audit_events` entry.
- Added recent import history (latest 20 batches) to the SuperAdmin import panel.
- Frontend source committed to `main`; it has NOT been built locally or deployed to Cloudflare in this session. Backend function is deployed. Do not claim end-to-end import works until a controlled CSV test succeeds.
- Suggested test: download template, import a few dummy records using active department/programme codes, verify import history, then test a duplicate registration number and a quoted address containing a comma. Do not import live student data until the template and validation have been tested.

## Safety boundaries
- Do not expose Supabase service-role keys or secrets.
- Do not create student accounts based only on registration number.
- Do not claim Paystack, SMS delivery, student imports or end-to-end workflows work until tested.
- Do not deploy the frontend or run migrations without the user's authorization.


## Student import requirements update — 2026-10-22

- The student CSV template must contain exactly two columns: `name` and `registration_number`. Sample rows only; no department, programme, phone, gender, address, or year fields in the import file.
- Import Edge Function now validates and inserts only `full_name` and `registration_number`; duplicate registrations within a file and existing registrations are rejected. Active function deployed to DSCP Supabase as `import-students` version 3, JWT verification enabled.
- Student portal first-time onboarding now asks for the registered name, registration number, and a phone number that the student can verify by SMS. Backend action `claim_record` links the verified phone to a unique matching student record, refuses a phone already linked to another record, and logs a claim event. The student then enters/confirm particulars in the portal, including department, programme, gender, and address. Department/programme selections are checked against active college lists and the selected programme must belong to the selected department.
- Updated `src/components/StudentImport.tsx`, `src/components/StudentPortal.tsx`, `supabase/functions/import-students/index.ts`, and `supabase/functions/student-portal/index.ts` in GitHub main. Student portal Edge Function redeployed with JWT verification enabled. No student records imported and no live data changed by this code edit.
- Important limitation: the claim process currently matches the official name and registration number and verifies phone ownership by SMS. This is not equivalent to an independent identity document check; monitor first-time claims and provide a college correction/recovery process.
- Next: when network connectivity to GitHub returns, pull main locally, run `npm run build`, deploy the frontend with `npx wrangler deploy`, then test using one dummy student row. Verify the template headers are exactly `name,registration_number`, validate/import one test record, claim it using a test phone, and complete the student profile. Do not import the full register until the end-to-end test passes.


## Current handoff — 2026-10-23: student password/payment flow

Work branch: `feature/student-password-payment-flow`  
Draft PR: https://github.com/olusamdev/digital-student-clearance-platform/pull/1

### Completed
- Applied additive migration `20261023064959_student_password_accounts.sql` to DSCP Supabase project `cipsazscgpyoaxwukmaw` (NOT the COHT CBT project).
- Added student Auth-link fields and durable payment registration/email audit fields.
- Added `student-payments` Edge Function source for Paystack initiation, verification and signed webhook reconciliation.
- Connected the student UI to registration lookup, checkout redirect, callback verification, recovery by existing Paystack reference, and password account setup.
- Added server-side account linking: requires a confirmed Auth email matching a successful payment's payer email; prevents overwriting an already-linked student record.
- Added `verify_jwt = false` for the webhook/payment function in local Supabase config. When deployed, the function must be deployed with JWT verification disabled because webhook requests are authenticated by Paystack HMAC; browser actions still enforce origin checks and use unpredictable references.

### Not yet deployed or tested
- Do not deploy the updated `student-portal` Edge Function before deploying the matching frontend; the existing live UI still uses the old phone-claim action.
- Do not deploy `student-payments` until the secret `PAYSTACK_SECRET_KEY` is set in the correct Supabase project's Edge Function secrets.
- Verify production Auth email confirmations are enabled and `https://dscp.olusamdev.workers.dev/student` is allow-listed for email confirmation/reset redirects. The code rejects account linking until Auth reports the email as confirmed.
- GitHub Actions passed on code commit `f858e96d622797232b7bc3e0ccae2b611d6f07f0`: `npm ci`, `npm run build`, and `deno check` for both student Edge Functions succeeded. Re-run CI after any further code changes.
- Live DB currently has no imported student records, no active clearance session, and no enabled required clearance requirements. A controlled student/session test fixture is needed.
- Payment-email matching verifies access to the receipt email, not legal identity by itself. The college must approve this as the onboarding check or provide a stronger identity-verification step before broad public launch.

### Next actions, in order
1. Review the draft PR and obtain a passing frontend build.
2. Verify production Auth confirmation + redirect settings and configure `PAYSTACK_SECRET_KEY` securely.
3. Import a controlled test student and configure an active clearance session plus required office requirements.
4. Test payment success, failed/cancelled payment, callback interruption, duplicate-charge prevention, email verification, account linking, password sign-in/reset, and staff-account exclusion.
5. Deploy `student-portal` and `student-payments` to `cipsazscgpyoaxwukmaw`, then deploy the frontend only after all tests pass.
6. Verify the live student flow and existing staff portals. Do not merge/deploy early; do not run further migrations unless needed and authorized.


## Latest update — 2026-10-23: no-email student access and assisted payment

This section supersedes the earlier email-based student onboarding notes above for the feature branch. The live site and deployed Edge Functions have **not** been changed by this work.

- Added feature-branch migration `20261023120000_student_activation_and_assisted_payment.sql` for hashed, single-use, 30-minute activation/reset codes and audit fields for staff-assisted payments. **Not applied remotely.**
- Added `manage-student-access` Edge Function source. Active Administrator/SuperAdmin roles can issue activation or reset codes; only SuperAdmin can change the student WhatsApp support number. Code redemption creates the student Auth identity or changes the password server-side. Raw codes are returned once to the issuing staff UI; only hashes are stored.
- First-time activation is blocked server-side until a successful payment is linked to the currently open clearance session. Students enter registration number, then a paid/unactivated record routes directly to activation/password setup. A single-use college-issued activation code is required; the student chooses and keeps their own password.
- Student passwords use deterministic internal Supabase Auth identifiers, not student email addresses. Student self-checkout uses the server secret `PAYSTACK_RECEIPT_EMAIL` for Paystack's required receipt email. Admin-assisted checkout uses the authenticated staff account email and stores the registration number plus initiating staff ID.
- Added the Administrator dashboard tools in `src/components/StudentAccessTools.tsx`; SuperAdmin sees only WhatsApp support configuration, not the assisted-payment/account-code tools.
- Student payment screen now has “Already paid? Contact support on WhatsApp”. The contact number is read from `app_settings.student_support_whatsapp` and can be changed by SuperAdmin after deployment.
- Added `manage-student-access` to the CI Deno check.

### Validation and remaining blockers
- GitHub Actions frontend build passed on commit `8a38ebfa6425b6374cef4fa164e3df0fb371aae5`; the Deno check then failed because `https://esm.sh/@supabase/supabase-js@2` returned HTTP 521 while Deno was downloading the dependency. This was an upstream fetch failure, not a reported TypeScript diagnostic. Recheck CI on the latest branch head.
- Do not deploy the new Edge Function or frontend, and do not apply the new migration, until CI passes and the payment/activation flows are reviewed together.
- Before enabling student self-checkout, set `PAYSTACK_SECRET_KEY` and a college-controlled `PAYSTACK_RECEIPT_EMAIL` as Edge Function secrets in the DSCP project `cipsazscgpyoaxwukmaw`. Do not use the COHT CBT Supabase project.
- Test in Paystack test mode with a dummy student and active clearance session: student-initiated payment; admin-assisted payment; webhook/callback verification; duplicate-payment prevention; paid student routing directly to activation; expired/reused activation code; invalid code; admin-issued password reset; support WhatsApp link; and staff-role denial for unauthorized callers.
- No migration, Edge Function deployment, frontend deployment, PR merge, or production data import was performed in this update.
