# Phase 4 manual acceptance checklist (test in non-production first)

## Authorization
- [ ] Unauthenticated requests rejected.
- [ ] Non-staff and non-SuperAdmin requests rejected.
- [ ] Inactive SuperAdmin rejected.
- [ ] Unapproved origin rejected; missing ALLOWED_ORIGIN fails closed.

## Invitation
- [ ] Valid invitation creates active staff profile, active role assignment, and audit event.
- [ ] Clearance Officer and Unit Head require active office; global roles reject office ID.
- [ ] SuperAdmin cannot be assigned through invitation endpoint.
- [ ] Invalid email/name/role rejected.
- [ ] Provisioning failure attempts to delete invited Auth user and logs rollback failures.
- [ ] Existing login/session restoration remains functional.

## Deactivation
- [ ] Self-deactivation rejected.
- [ ] Auth sign-in suspended and profile/role assignments deactivated.
- [ ] Audit event records actor, target, reason, and timestamp.
- [ ] Last active SuperAdmin cannot be deactivated.
- [ ] Failure attempts to restore prior Auth ban state; rollback failure is logged.

## Data/security
- [ ] Audit ID auto-generates as IDENTITY ALWAYS.
- [ ] Direct client INSERT/UPDATE/DELETE remains denied.
- [ ] RLS remains enabled and audit table is not writable by anon/authenticated clients.
- [ ] Service-role secret absent from frontend, browser requests, and Git history.
- [ ] Invitation redirect route verified; backup/recovery documented.
- [ ] Staff-management UI integrated only after backend checks pass.
- [ ] Student-facing flow and live payments remain disabled until separately secured.
