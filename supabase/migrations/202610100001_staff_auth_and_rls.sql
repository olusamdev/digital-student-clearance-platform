-- COHT Digital Student Clearance Platform
-- Phase 2: staff identity helpers and least-privilege read access.
-- This migration intentionally grants NO direct client writes to operational tables.
-- Mutations must be exposed through narrowly scoped, audited RPCs/Edge Functions.
begin;

-- Make role checks require both an active staff profile and an active assignment.
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles sp
    where sp.user_id = auth.uid()
      and sp.active = true
  );
$$;

create or replace function public.has_role(required_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_staff() and exists (
    select 1
    from public.staff_role_assignments sra
    where sra.user_id = auth.uid()
      and sra.role = required_role
      and sra.active = true
  );
$$;

create or replace function public.has_office_role(
  target_office_id uuid,
  allowed_roles public.app_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_staff() and exists (
    select 1
    from public.staff_role_assignments sra
    where sra.user_id = auth.uid()
      and sra.office_id = target_office_id
      and sra.role = any(allowed_roles)
      and sra.active = true
  );
$$;

-- SECURITY DEFINER scope helpers prevent RLS recursion while keeping every
-- check tied to auth.uid(). They are read-only and cannot accept an actor ID.
create or replace function public.can_access_session_student(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_staff() and (
    public.has_role('superadmin'::public.app_role)
    or public.has_role('admin'::public.app_role)
    or public.has_role('provost'::public.app_role)
    or exists (
      select 1
      from public.session_students ss
      where ss.id = target_id
        and ss.final_assent = 'assented'::public.final_assent_status
        and ss.completed_at is not null
        and (
          public.has_role('registrar'::public.app_role)
          or public.has_role('certification_officer'::public.app_role)
        )
    )
    or exists (
      select 1
      from public.clearance_requests cr
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role in ('clearance_officer'::public.app_role, 'unit_head'::public.app_role)
      where cr.session_student_id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
    )
  );
$$;

create or replace function public.can_access_clearance_request(target_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_staff() and (
    public.has_role('superadmin'::public.app_role)
    or public.has_role('admin'::public.app_role)
    or public.has_role('provost'::public.app_role)
    or exists (
      select 1
      from public.clearance_requests cr
      join public.session_students ss on ss.id = cr.session_student_id
      where cr.id = target_id
        and ss.final_assent = 'assented'::public.final_assent_status
        and ss.completed_at is not null
        and (
          public.has_role('registrar'::public.app_role)
          or public.has_role('certification_officer'::public.app_role)
        )
    )
    or exists (
      select 1
      from public.clearance_requests cr
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role in ('clearance_officer'::public.app_role, 'unit_head'::public.app_role)
      where cr.id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
    )
  );
$$;

create or replace function public.can_access_student_record(target_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_active_staff() and (
    public.has_role('superadmin'::public.app_role)
    or public.has_role('admin'::public.app_role)
    or public.has_role('provost'::public.app_role)
    or exists (
      select 1
      from public.session_students ss
      where ss.student_id = target_student_id
        and ss.final_assent = 'assented'::public.final_assent_status
        and ss.completed_at is not null
        and (
          public.has_role('registrar'::public.app_role)
          or public.has_role('certification_officer'::public.app_role)
        )
    )
    or exists (
      select 1
      from public.session_students ss
      join public.clearance_requests cr on cr.session_student_id = ss.id
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role in ('clearance_officer'::public.app_role, 'unit_head'::public.app_role)
      where ss.student_id = target_student_id
        and cr.status <> 'not_requested'::public.clearance_status
    )
  );
$$;

-- Only authenticated staff should be able to call these helpers.
revoke all on function public.is_active_staff() from public, anon;
revoke all on function public.has_role(public.app_role) from public, anon;
revoke all on function public.has_office_role(uuid, public.app_role[]) from public, anon;
revoke all on function public.can_access_session_student(uuid) from public, anon;
revoke all on function public.can_access_clearance_request(uuid) from public, anon;
revoke all on function public.can_access_student_record(uuid) from public, anon;
grant execute on function public.is_active_staff() to authenticated;
grant execute on function public.has_role(public.app_role) to authenticated;
grant execute on function public.has_office_role(uuid, public.app_role[]) to authenticated;
grant execute on function public.can_access_session_student(uuid) to authenticated;
grant execute on function public.can_access_clearance_request(uuid) to authenticated;
grant execute on function public.can_access_student_record(uuid) to authenticated;

-- Remove any default table privileges from public/anonymous/authenticated clients,
-- then allow SELECT only. All data visibility is governed by the policies below.
revoke all on table
  public.staff_profiles,
  public.departments,
  public.programmes,
  public.clearance_offices,
  public.staff_role_assignments,
  public.student_records,
  public.clearance_sessions,
  public.clearance_requirements,
  public.session_students,
  public.app_settings,
  public.payment_transactions,
  public.clearance_requests,
  public.clearance_comments,
  public.audit_events,
  public.notifications,
  public.certification_records,
  public.import_batches
from public, anon, authenticated;

grant select on table
  public.staff_profiles,
  public.departments,
  public.programmes,
  public.clearance_offices,
  public.staff_role_assignments,
  public.student_records,
  public.clearance_sessions,
  public.clearance_requirements,
  public.session_students,
  public.app_settings,
  public.payment_transactions,
  public.clearance_requests,
  public.clearance_comments,
  public.audit_events,
  public.notifications,
  public.certification_records,
  public.import_batches
to authenticated;

-- Staff identity and role assignments.
create policy staff_profiles_select_self_or_superadmin
on public.staff_profiles for select to authenticated
using (user_id = auth.uid() or public.has_role('superadmin'::public.app_role));

create policy staff_role_assignments_select_self_or_superadmin
on public.staff_role_assignments for select to authenticated
using (user_id = auth.uid() or public.has_role('superadmin'::public.app_role));

-- Reference data is visible to active staff; inactive entries are SuperAdmin-only.
create policy departments_select_active_staff
on public.departments for select to authenticated
using (public.is_active_staff() and (active or public.has_role('superadmin'::public.app_role)));

create policy programmes_select_active_staff
on public.programmes for select to authenticated
using (public.is_active_staff() and (active or public.has_role('superadmin'::public.app_role)));

create policy clearance_offices_select_active_staff
on public.clearance_offices for select to authenticated
using (public.is_active_staff() and (active or public.has_role('superadmin'::public.app_role)));

create policy clearance_sessions_select_staff_scope
on public.clearance_sessions for select to authenticated
using (
  public.is_active_staff()
  and (active or public.has_role('superadmin'::public.app_role) or public.has_role('admin'::public.app_role))
);

create policy clearance_requirements_select_staff_scope
on public.clearance_requirements for select to authenticated
using (
  public.is_active_staff()
  and (enabled or public.has_role('superadmin'::public.app_role) or public.has_role('admin'::public.app_role))
);

create policy app_settings_select_public_config_keys
on public.app_settings for select to authenticated
using (
  public.is_active_staff()
  and (
    setting_key in ('clearance_fee_kobo', 'payment_currency', 'officer_reminder_interval_hours')
    or public.has_role('superadmin'::public.app_role)
  )
);

-- Student identity and session records are scoped by role and office assignment.
create policy student_records_select_scoped_staff
on public.student_records for select to authenticated
using (public.can_access_student_record(id));

create policy session_students_select_scoped_staff
on public.session_students for select to authenticated
using (public.can_access_session_student(id));

create policy clearance_requests_select_scoped_staff
on public.clearance_requests for select to authenticated
using (public.can_access_clearance_request(id));

create policy clearance_comments_select_scoped_staff
on public.clearance_comments for select to authenticated
using (public.can_access_clearance_request(clearance_request_id));

-- Financial details are limited to administrative and senior oversight roles.
create policy payment_transactions_select_finance_roles
on public.payment_transactions for select to authenticated
using (
  public.has_role('superadmin'::public.app_role)
  or public.has_role('admin'::public.app_role)
  or public.has_role('registrar'::public.app_role)
  or public.has_role('provost'::public.app_role)
);

-- Audit events and import reports contain sensitive operational information.
create policy audit_events_select_admin_roles
on public.audit_events for select to authenticated
using (
  public.has_role('superadmin'::public.app_role)
  or public.has_role('admin'::public.app_role)
);

create policy import_batches_select_admin_roles
on public.import_batches for select to authenticated
using (
  public.has_role('superadmin'::public.app_role)
  or public.has_role('admin'::public.app_role)
);

-- Staff can read their own in-app notifications. Students have no direct table access.
create policy notifications_select_recipient_or_superadmin
on public.notifications for select to authenticated
using (
  (public.is_active_staff() and recipient_user_id = auth.uid())
  or public.has_role('superadmin'::public.app_role)
);

-- Certification staff can see only records already assented to and completed.
create policy certification_records_select_scoped_roles
on public.certification_records for select to authenticated
using (
  public.has_role('superadmin'::public.app_role)
  or public.has_role('admin'::public.app_role)
  or public.has_role('registrar'::public.app_role)
  or public.has_role('provost'::public.app_role)
  or (
    public.has_role('certification_officer'::public.app_role)
    and exists (
      select 1
      from public.session_students ss
      where ss.id = certification_records.session_student_id
        and ss.final_assent = 'assented'::public.final_assent_status
        and ss.completed_at is not null
    )
  )
);

commit;
