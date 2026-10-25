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

- Added migration `20261023214359_student_activation_and_assisted_payment.sql` for hashed, single-use, 30-minute activation/reset codes and audit fields for staff-assisted payments. Applied to the correct DSCP Supabase project `cipsazscgpyoaxwukmaw`; migration history and table/column existence were verified.
- Added `manage-student-access` Edge Function source. Active Administrator/SuperAdmin roles can issue activation or reset codes; only SuperAdmin can change the student WhatsApp support number. Student code redemption is public before sign-in (required for first activation and forgotten-password recovery); it validates the single-use code and changes the Auth identity/password server-side. Raw codes are returned once to the issuing staff UI; only hashes are stored.
- First-time activation is blocked server-side until a successful payment is linked to the currently open clearance session. Students enter registration number, then a paid/unactivated record routes directly to activation/password setup. A single-use college-issued activation code is required; the student chooses and keeps their own password.
- Student passwords use deterministic internal Supabase Auth identifiers, not student email addresses. Student self-checkout uses the server secret `PAYSTACK_RECEIPT_EMAIL` for Paystack's required receipt email. Admin-assisted checkout uses the authenticated staff account email and stores the registration number plus initiating staff ID.
- Added the Administrator dashboard tools in `src/components/StudentAccessTools.tsx`; SuperAdmin sees only WhatsApp support configuration, not the assisted-payment/account-code tools.
- Student payment screen now has “Already paid? Contact support on WhatsApp”. The contact number is read from `app_settings.student_support_whatsapp` and can be changed by SuperAdmin after deployment.
- Added `manage-student-access` to the CI Deno check.

### Validation and remaining blockers
- One CI attempt failed because `https://esm.sh/@supabase/supabase-js@2` returned HTTP 521 during dependency download (no TypeScript diagnostic was reported). CI subsequently passed `npm ci`, `npm run build`, and `deno check` for `student-portal`, `student-payments`, and `manage-student-access` on commit `7e681749927109f9536f382f22ac940f577d945f`, including the fix that allows unauthenticated students to redeem one-time codes.
- The database migration is applied, but the new Edge Function and frontend remain undeployed. Do not deploy either until a Paystack test-mode end-to-end run is completed.
- Before enabling student self-checkout, set `PAYSTACK_SECRET_KEY` and a college-controlled `PAYSTACK_RECEIPT_EMAIL` as Edge Function secrets in the DSCP project `cipsazscgpyoaxwukmaw`. Do not use the COHT CBT Supabase project.
- Test in Paystack test mode with a dummy student and active clearance session: student-initiated payment; admin-assisted payment; webhook/callback verification; duplicate-payment prevention; paid student routing directly to activation; expired/reused activation code; invalid code; admin-issued password reset; support WhatsApp link; and staff-role denial for unauthorized callers.
- The additive database migration was applied and verified. No Edge Function deployment, frontend deployment, PR merge, or production student import was performed. The production database currently has zero student records and no active clearance session, so end-to-end payment/activation testing cannot yet be run against a real record. Confirm Paystack test/live mode and secrets before deployment.


## Production deployment investigation — 2026-10-25

This update supersedes earlier statements that the latest student payment/account code had not been deployed.

- GitHub `main` commit `825eab715a986557585a4f7e8df4af8bca32cd7b` adds `.github/workflows/deploy-cloudflare.yml`. Previously, the repository had a validation workflow only; there was no automated Cloudflare frontend deployment workflow.
- The frontend build and validation workflow passed on this commit. The Cloudflare deployment job reached the deploy step but failed. Check GitHub Actions run `40141495881` and verify repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are present and valid. Do not store these in Git.
- DSCP Supabase project `cipsazscgpyoaxwukmaw`: deployed `student-portal` v8, `student-payments` v1, and `manage-student-access` v1. Sources were deployed from GitHub `main`; the shared CORS module was bundled with each function. `student-portal` has JWT verification enabled. The other two have JWT verification disabled because their handlers support public payment/webhook or pre-sign-in code-redemption flows and enforce their own request checks.
- The Edge Function deployment does not establish that payment configuration is complete. Verify that Supabase Edge Function secrets `PAYSTACK_SECRET_KEY` and the college-controlled `PAYSTACK_RECEIPT_EMAIL` (or the supported `COLLEGE_RECEIPT_EMAIL` fallback) are set in this DSCP project. Never expose their values in chat or source control.
- Live database check: 50 student records, zero active clearance sessions, zero enabled requirements, and zero payment transactions. Do not create or activate a session or import production data without explicit approval. End-to-end payment/clearance testing remains blocked until a controlled session and requirements are configured.
- Security advisor still reports RLS-enabled tables with no policies for `staff_deletion_reservations` and `student_access_tokens`, several callable `SECURITY DEFINER` functions, and disabled leaked-password protection. Review these before broad launch.
- Next: configure/verify Cloudflare GitHub Actions secrets, rerun the Cloudflare deployment workflow, verify the live `/student` and existing staff/Registrar routes, then configure Paystack test-mode secrets and run controlled end-to-end tests. No local pull was performed.


## Production deployment recovered — 2026-10-25

- Fixed `.github/workflows/deploy-cloudflare.yml`: upgraded to `cloudflare/wrangler-action@v4` and Node.js 22.
- Root cause of the previous deployment failure was Wrangler v3 rejecting the assets-only configuration with `Missing entry-point`; it was not a token error.
- GitHub Actions deployment run succeeded: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40191961324
- Deployment targeted the existing Cloudflare Worker `dscp`, configured in `wrangler.jsonc`; no new Worker/site was created.
- Frontend build and Cloudflare deploy steps both passed. Confirm the live UI in a browser after refreshing; do not infer feature-level correctness from deployment success alone.


## 2026-10-25 — Correct student activation and WhatsApp validation
- Student-initiated Paystack payment must lead directly to password creation without an activation code; admin-assisted payment still requires the single-use college-issued activation code.
- Student portal lookup now returns whether a code is required based on the latest successful transaction for the active session. If no successful student-initiated transaction can be verified, code requirement defaults to true.
- Added server-side `complete_student_activation`: code-free account creation is allowed only for a verified successful `student_initiated` payment linked to an active clearance session. Admin-assisted or manually recorded payments cannot use this path.
- Fixed the SuperAdmin WhatsApp validator's over-escaped regex, which rejected ordinary digits-only numbers. It accepts 10–15 digits after removing common formatting; for Nigeria use country code, e.g. `2348012345678`.
- Validation and deployment completed:
  - PR #3 merged to `main` as `fc70d74f871441fcfabebfb38dd4fc546a8acd33`.
  - GitHub Actions passed `npm ci`, `npm run build`, and Deno checks for `student-portal`, `student-payments`, and `manage-student-access`.
  - Existing Cloudflare Worker frontend deployment succeeded: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40196833403
  - DSCP Supabase Edge Functions deployed: `student-portal` v10 (JWT verification remains enabled), `manage-student-access` v3 (function-level authorization retained).
  - Latest test transaction is recorded as successful `student_initiated`, NGN 1,700, and clearance access is unlocked; the student account is not yet activated. This is eligible for the new code-free password setup path.
  - SuperAdmin WhatsApp validation now accepts 10–15 digits after removing common formatting; for Nigeria, use digits with country code such as `2348012345678`.
- Still required: user retests the already-paid student on `/student` (enter registration number; do not pay again) and confirms password creation appears without activation code; user also retries saving the WhatsApp support number. Separately verify an admin-assisted payment still requests its activation code.


## 2026-10-25 — Admin-assisted payment and simplified admin workspace

Branch: `fix/admin-payment-return-and-simplify-admin`

- Admin-assisted Paystack checkout now returns to the existing staff dashboard (`/`) rather than the student portal. The dashboard reads Paystack's callback reference, verifies it through `student-payments`, and shows a success notice only after server verification succeeds.
- Student activation no longer requires a one-time activation code, regardless of whether the payment was student-initiated or admin-assisted. The student enters their registration number at `/student`; if payment is verified and the account is not yet activated, the portal opens password setup directly.
- Server-side activation accepts any successful verified payment attached to the current open session; it does not trust the browser's payment status. Legacy activation-code issue/redeem actions are disabled. Password-reset codes remain available for account recovery.
- Removed the OfficeClearance dashboard component, including office queue/completed-clearance sections. Staff invitation role choices are limited to Administrator; SuperAdmin remains a platform role. The dedicated Provost route is no longer rendered from the main app.
- Files changed: `src/App.tsx`, `src/components/StudentPortal.tsx`, `src/components/StudentAccessTools.tsx`, `supabase/functions/student-portal/index.ts`, `supabase/functions/manage-student-access/index.ts`, `supabase/functions/student-payments/index.ts`.
- Status: changes are on the feature branch and still require CI/build checks, review, merge, deployment of the three changed Supabase Edge Functions, and Cloudflare frontend deployment. Do not describe production as updated until those steps pass.
- Retest after deployment: (1) admin-assisted Paystack payment returns to dashboard and confirms success, (2) paid student enters registration number and creates password without a code, (3) student self-payment still works, (4) password-reset code still works, (5) staff dashboard has no office queue or completed-clearance sections.

- CI initially caught two TypeScript comparisons left over from the removed activation-code branches. Those branches were simplified to password-reset-only logic; rerun validation against the latest branch head before merge.

- Callback robustness: admin-assisted checkout uses a clean dashboard URL, allowing Paystack to append its reference parameters without a pre-existing query string. The dashboard verifies the reference only on `/`.


## Production deployment — 2026-10-25

- PR #4 and PR #5 are merged to `main`. GitHub validation passed.
- Cloudflare deployment passed: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40199814367. The existing Worker `dscp` was updated.
- DSCP Edge Functions are ACTIVE: `student-portal` v11 (`verify_jwt=true`), `student-payments` v5 (`verify_jwt=false`), and `manage-student-access` v4 (`verify_jwt=false`). Deployed sources were checked for code-free activation and the admin callback flow.
- Browser end-to-end retest is still pending: complete a test-mode admin-assisted payment, confirm return to the staff dashboard with server-verified success, then look up the paid student's registration number at `/student` and confirm direct password setup without an activation code. Also confirm student-initiated payment and password-reset recovery still work.


## Student panel fixes — 2026-10-25

- Gender dropdown now offers only Female and Male. Frontend values are normalized to lowercase and the `student-portal` Edge Function validates and saves `female`/`male`, matching the database check constraint. Root cause of the previous save error was PostgreSQL check violation `23514` on `student_records_gender_check` because the UI submitted `Male` instead of `male`.
- Removed the `STUDENT WORKSPACE` eyebrow, the registration-number helper description, and the Clearance Fee card from the student dashboard. Server-side payment checks remain in place; removing the card does not bypass the payment gate.
- Clarified the empty requirements message. Database check on the active `2025/2026` session found zero enabled requirements and zero enabled required requirements. Do not create/configure requirements without explicit authorization; clearance requests remain blocked until the college configures them.
- Files changed: `src/components/StudentPortal.tsx`, `supabase/functions/student-portal/index.ts`.
- Validation/deployment status: pending CI, merge, Cloudflare frontend deployment, and deployment of the updated `student-portal` Edge Function. After deployment, retest saving particulars with Male and Female and confirm the card/descriptions are gone.


### Deployment result — student panel fixes

- PR #7 merged as `0d5b2c3341c50fb533d866f5c859c515cd94613f`.
- Validation passed: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40218805863
- Cloudflare frontend deployment passed: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40218805850
- Supabase `student-portal` Edge Function deployed as ACTIVE version 12 (`verify_jwt=true)); fetched deployed source confirms lowercase gender normalization and male/female validation.
- Still needs browser retest by user: save particulars using Male and Female; verify the old helper text, workspace label, and fee card are absent. The active session still has no enabled clearance requirements; this was intentionally not changed.


## SuperAdmin clearance requirements management — 2026-10-25 (work in progress)

- Work branch: `feature/superadmin-clearance-requirements`.
- Added `src/components/ClearanceRequirements.tsx` and mounted it only under the existing `isSuperAdmin` gate in `src/App.tsx`.
- Panel supports listing, creating, editing, enabling/disabling requirements, mandatory/optional status, instructions, display order, and optional department/programme scope. New requirements default to disabled in the form. Administrators' payment-only access is unchanged.
- Added `supabase/functions/manage-clearance-requirements/index.ts`; it requires a valid signed-in user and routes list/save/toggle through a service-role RPC. The database function independently verifies an active SuperAdmin role and writes audit events.
- Added migration `supabase/migrations/202610250001_manage_clearance_requirements.sql`. It has NOT been applied to Supabase. No requirements were created or enabled.
- Validation is incomplete: no local build or CI result yet. Do not merge/deploy or apply the migration until the PR is reviewed and validation passes. After merge approval, apply the migration to DSCP project `cipsazscgpyoaxwukmaw`, deploy the new Edge Function, run CI/build, then deploy the frontend only following the established user-controlled deployment workflow.
- The existing active `2025/2026` session and payment-verification enforcement were not changed. Keep all requirements unconfigured until the college decides the actual office/requirement list.


## SuperAdmin clearance requirements — deployment update — 2026-10-25

- PR #9 merged to `main` as merge commit `9042bc273a0342351d124bda83720a137f250fa0`.
- GitHub Actions validation passed: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40220830428
- Cloudflare frontend deployment passed: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40220830427. The existing Worker remains `dscp`.
- Applied migration `20261025190313_manage_clearance_requirements` to DSCP Supabase project `cipsazscgpyoaxwukmaw`. Migration history confirms it is recorded.
- Deployed `manage-clearance-requirements` as ACTIVE version 1 with JWT verification enabled. The shared CORS logic is bundled into the deployed entrypoint.
- Verified RPC execute permissions: `anon=false`, `authenticated=false`, `service_role=true`.
- No clearance requirements were created or enabled. Existing active session, payment gate, and Administrator payment-only permissions were not changed.
- Follow-up hardening: added `manage-clearance-requirements/index.ts` to the Deno check in `.github/workflows/validate.yml` (commit `5686cd5867d0d2f3a7ac3102b7c15724dec46124`). The updated CI run passed, including the new function: https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40224309998.
- Still required: verify the latest CI run, then test the SuperAdmin panel in production using the college's actual configuration decisions. Do not enable requirements until the college confirms the approved offices/requirements and scope.


## Bug fix in progress — Provost queue and staff invitation roles — 2026-10-25

- Confirmed the prior UI restriction to Administrator was introduced in commit `1715d8c` while simplifying the staff workspace. The invitation Edge Function still accepts all six non-SuperAdmin roles.
- Restored the six role choices: Administrator, Clearance Officer, Unit Head, Registrar, Provost, and Certification Officer. Clearance Officer and Unit Head still require an office assignment; SuperAdmin remains excluded from invitations.
- Restored the dedicated `/provost` route, which had been removed from the app while its navigation link and `ProvostPortal` component remained.
- Fixed `manage-clearance` response handling so roles without platform-wide queue access only receive requests for their explicitly assigned office(s). A Provost-only account now receives an empty office-request list while retaining the separate Final Assent queue; a Provost who also has an office-scoped role sees only that office's requests.
- Added `manage-clearance/index.ts` to CI's Deno checks.
- Branch: `fix/provost-queue-and-staff-roles`; PR #10: https://github.com/olusamdev/digital-student-clearance-platform/pull/10. CI passed (`npm ci`, `npm run build`, and Deno checks including `manage-clearance`): https://github.com/olusamdev/digital-student-clearance-platform/actions/runs/40230166238. Not merged or deployed yet.
- Live production retest remains necessary after merge/deployment: verify office staff only see their assigned office requests, Provost sees no office requests but sees eligible Final Assent cases, and each of the six invite roles can be selected (with office required only for Clearance Officer/Unit Head).
