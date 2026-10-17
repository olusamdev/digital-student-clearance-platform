# COHT Digital Student Clearance — Phase 5 Staff Management UI

This package extends the Phase 3 React/Vite staff portal while preserving its existing email/password sign-in design. It adds a SuperAdmin-only staff directory, invite form, account deactivation confirmation, an invitation password-acceptance route, and a new `list-staff` Edge Function. The browser uses only the Supabase anon/publishable key.

## Apply to the existing local project

Project folder: `C:\Users\ADMIN\Documents\CodeProjects\Digital Student Clearance Platform`

1. Make a Git commit or copy of the current workspace first.
2. Merge the contents of this package into the project root, comparing files if asked to overwrite. Do not replace `.env.local`.
3. In the Supabase Dashboard for project `cipsazscgpyoaxwukmaw`, open **Authentication → URL Configuration** and add `http://127.0.0.1:5173/accept-invite` to **Redirect URLs**.
4. Set the invite redirect secret from PowerShell in the project folder:
   ```powershell
   supabase secrets set STAFF_INVITE_REDIRECT_URL="http://127.0.0.1:5173/accept-invite"
   ```
   `ALLOWED_ORIGIN` should already be `http://127.0.0.1:5173`. Do not switch between `localhost` and `127.0.0.1`; they are different origins.
5. Deploy the new listing function:
   ```powershell
   supabase functions deploy list-staff
   ```
   `invite-staff` and `deactivate-staff` have already been deployed. This package does not redeploy or replace them.
6. Build and run the frontend:
   ```powershell
   npm install
   npm run build
   npm run dev
   ```
7. Sign in with the active SuperAdmin. The Staff management section appears only for active SuperAdmin role holders. Confirm it is absent for a non-SuperAdmin account.

## Included

- Existing sign-in and profile/role summary retained.
- SuperAdmin-only staff directory via `list-staff`, which verifies the bearer session and checks active profile + active SuperAdmin assignment before using the service-role client.
- Invite form for approved roles, optional staff number, and active office selection for `clearance_officer`/`unit_head`.
- SuperAdmin role assignment is intentionally excluded from the UI.
- Deactivation confirmation with optional audit reason, using the existing `deactivate-staff` function.
- `/accept-invite` password setup screen for a valid invitation session (minimum 12 characters).
- Clear server errors and directory refresh after actions.

## Verification status and safety

The code is authored but **not yet built or tested against the live project**. A local dependency-install attempt timed out in the authoring environment, so this package is not being represented as build-verified. Run `npm run build` locally before operational use.

After deployment, test: invitation delivery; password acceptance; staff directory as SuperAdmin; directory denial as a non-SuperAdmin; invalid/expired invitation links; and deactivation including the last-SuperAdmin protection. Confirm `ALLOWED_ORIGIN` and `STAFF_INVITE_REDIRECT_URL` exist in Edge Function secrets without revealing their values. Never put a service-role key in `.env.local`, browser code, or Git.
