# Phase 4 manual acceptance checklist (test in non-production first)

## Authorization
- [ ] Unauthenticated requests rejected.
- [ ] Non-staff and non-SuperAdmin requests rejected.
- [ ] Inactive SuperAdmin rejected.
- [ ] Unapproved origin rejected; missing ALLOWED_ORIGIN fails closed.

## Registrar data scope (migration 202610170001)
Apply `supabase/migrations/202610170001_registrar_queue_scope.sql` to a disposable/test database before running these checks. Do not apply it to production without approval.

- [ ] Pure Registrar (`registrar` only) calling `list_queue` receives `requests: []` when pending, needs-attention, and cleared requests exist.
- [ ] Pure Registrar's raw `list_queue` response contains no pending request IDs, office instructions, or comments (verify the JSON, not only the UI).
- [ ] Registrar `completed_queue` includes only `final_assent = 'assented'` rows with `completed_at IS NOT NULL`; pending, declined, revoked, and assented-without-completion rows are absent.
- [ ] Registrar `assent_queue` is empty; `final_assent` and `set_reminder_interval` return 403/42501 for a pure Registrar.
- [ ] Registrar direct table reads of `session_students`, `clearance_requests`, and `student_records` return only assented-and-completed rows through RLS.
- [ ] Registrar `clear` and `comment` on a pending request return 403/42501; no request, comment, audit event, or notification is written.
- [ ] Provost still receives the pending-request queue and assent queue, and can grant, decline, or revoke Final Assent.
- [ ] Clearance Officer and Unit Head still receive only requests for their assigned office and can clear/comment only those requests.
- [ ] Admin and SuperAdmin still receive all workspace requests and the completed queue.
- [ ] Combined roles: Registrar + Clearance Officer/Unit Head sees only that office's pending requests (plus the completed queue); Registrar + Admin/SuperAdmin sees the broad pending queue; Registrar + Provost sees the broad pending queue and assent queue; pure Registrar sees no pending requests.
- [ ] Actor identity: send `p_actor_user_id` or `actor_user_id` for another user in the Edge Function body; confirm the function still uses `userData.user.id` from the bearer token and ignores the supplied value.
- [ ] Registrar staff UI shows no pending-request cards and still displays the completed-queue table.
- [ ] Unauthenticated requests, inactive staff, and unapproved origins remain rejected.

Automated note: this repository has no automated test runner, no SQL/RLS test harness, and no local Supabase stack wired for tests. The production build validates TypeScript only, so these database and Edge Function behaviours must be verified manually in a disposable environment.

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
