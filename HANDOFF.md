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
