begin;

alter table public.staff_profiles
  drop constraint if exists staff_profiles_user_id_fkey;
alter table public.staff_profiles
  add constraint staff_profiles_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

alter table public.staff_role_assignments
  drop constraint if exists staff_role_assignments_user_id_fkey;
alter table public.staff_role_assignments
  add constraint staff_role_assignments_user_id_fkey
  foreign key (user_id) references public.staff_profiles(user_id) on delete cascade;

create table public.staff_deletion_reservations (
  operation_id uuid primary key,
  target_user_id uuid not null,
  actor_user_id uuid not null,
  status text not null default 'prepared',
  details jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('prepared', 'finalized', 'aborted'))
);
create unique index staff_deletion_reservations_one_prepared_per_target
  on public.staff_deletion_reservations(target_user_id)
  where status = 'prepared';
create unique index staff_deletion_reservations_one_finalized_per_target
  on public.staff_deletion_reservations(target_user_id)
  where status = 'finalized';
create index staff_deletion_reservations_target_created_idx
  on public.staff_deletion_reservations(target_user_id, created_at desc);
alter table public.staff_deletion_reservations enable row level security;
revoke all on table public.staff_deletion_reservations from public, anon, authenticated;

drop function if exists public.finalize_staff_deletion(uuid, uuid, text, boolean);
drop function if exists public.abort_staff_deletion(uuid, uuid);
drop function if exists public.recover_staff_deletion(uuid, uuid);
drop function if exists public.find_staff_deletion_operation(uuid, uuid);

create or replace function public.prepare_staff_deletion(
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid := gen_random_uuid();
  v_target_email text;
  v_profile_email text;
  v_target_staff_number text;
  v_auth_email text;
  v_target_name text;
  v_target_active boolean;
  v_profile_exists boolean;
  v_auth_exists boolean;
  v_roles jsonb;
  v_target_is_active_superadmin boolean := false;
  v_remaining_superadmins bigint;
  v_deletion_details jsonb;
begin
  if p_actor_user_id is null or p_target_user_id is null then
    raise exception 'Actor and target user are required';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'You cannot delete your own account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(712041, 1);

  if not exists (
    select 1
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id
      and sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  ) then
    raise exception 'Active SuperAdmin required' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.staff_deletion_reservations r
    where r.target_user_id = p_target_user_id
      and r.status = 'finalized'
  ) then
    raise exception 'Staff deletion has already been finalized' using errcode = '55000';
  end if;

  if exists (
    select 1
    from public.staff_deletion_reservations r
    where r.target_user_id = p_target_user_id
      and r.status = 'prepared'
  ) then
    raise exception 'Staff deletion is already in progress' using errcode = '55000';
  end if;

  select sp.email, sp.staff_number, sp.full_name, sp.active
    into v_profile_email, v_target_staff_number, v_target_name, v_target_active
  from public.staff_profiles sp
  where sp.user_id = p_target_user_id;
  v_profile_exists := found;

  if not v_profile_exists then
    raise exception 'Staff profile not found' using errcode = 'P0002';
  end if;

  select au.email
    into v_auth_email
  from auth.users au
  where au.id = p_target_user_id;
  v_auth_exists := found;

  v_target_email := coalesce(nullif(v_profile_email, ''), v_auth_email);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'role', sra.role::text,
        'office_id', sra.office_id,
        'active', sra.active
      ) order by sra.created_at, sra.id
    ),
    '[]'::jsonb
  )
  into v_roles
  from public.staff_role_assignments sra
  where sra.user_id = p_target_user_id;

  v_target_is_active_superadmin := coalesce(v_target_active, false) and exists (
    select 1
    from public.staff_role_assignments sra
    where sra.user_id = p_target_user_id
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  );

  v_deletion_details := jsonb_build_object(
    'operation_id', v_operation_id,
    'target_user_id', p_target_user_id,
    'actor_user_id', p_actor_user_id,
    'email', v_target_email,
    'profile_email', v_profile_email,
    'profile_staff_number', v_target_staff_number,
    'full_name', v_target_name,
    'profile_exists', v_profile_exists,
    'profile_active', v_target_active,
    'auth_exists', v_auth_exists,
    'roles', v_roles,
    'target_is_active_superadmin', v_target_is_active_superadmin
  );

  if v_target_is_active_superadmin then
    select count(distinct sp.user_id)
      into v_remaining_superadmins
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    join auth.users au on au.id = sp.user_id
    where sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
      and sp.user_id <> p_target_user_id
      and not exists (
        select 1
        from public.staff_deletion_reservations r
        where r.target_user_id = sp.user_id
          and r.status = 'prepared'
      );

    if coalesce(v_remaining_superadmins, 0) < 1 then
      raise exception 'Cannot delete the last active SuperAdmin';
    end if;
  end if;

  insert into public.staff_deletion_reservations (
    operation_id, target_user_id, actor_user_id, status, details
  ) values (
    v_operation_id, p_target_user_id, p_actor_user_id, 'prepared', v_deletion_details
  );

  insert into public.audit_events (
    actor_user_id, event_type, entity_type, entity_id, details
  ) values (
    case
      when exists (select 1 from auth.users au where au.id = p_actor_user_id)
        then p_actor_user_id
      else null
    end,
    'staff.deletion_started',
    'staff_profile',
    p_target_user_id::text,
    v_deletion_details
  );

  return v_deletion_details;
end;
$$;

create or replace function public.finalize_staff_deletion(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.staff_deletion_reservations%rowtype;
  v_details jsonb;
  v_final_details jsonb;
  v_target_email text;
  v_target_name text;
  v_target_active boolean;
  v_profile_removed boolean;
  v_current_profile_exists boolean;
  v_target_is_active_superadmin boolean := false;
  v_remaining_superadmins bigint;
  v_roles jsonb;
  v_auth_exists boolean;
  v_auth_account_deleted boolean;
begin
  if p_operation_id is null or p_actor_user_id is null or p_target_user_id is null then
    raise exception 'Operation, actor, and target user are required';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'You cannot delete your own account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(712041, 1);

  if not exists (
    select 1
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id
      and sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  ) then
    raise exception 'Active SuperAdmin required' using errcode = '42501';
  end if;

  select r.*
    into v_operation
  from public.staff_deletion_reservations r
  where r.operation_id = p_operation_id
    and r.actor_user_id = p_actor_user_id
    and r.target_user_id = p_target_user_id;

  if not found then
    select ae.details
      into v_final_details
    from public.audit_events ae
    where ae.event_type = 'staff.deleted'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
    order by ae.occurred_at desc, ae.id desc
    limit 1;

    if found then
      select exists (
        select 1
        from auth.users au
        where au.id = p_target_user_id
      )
      into v_auth_exists;

      if v_auth_exists then
        return jsonb_build_object(
          'status', 'auth_present',
          'operation_id', p_operation_id
        );
      end if;

      return jsonb_build_object(
        'status', 'already_finalized',
        'operation_id', p_operation_id,
        'email', nullif(v_final_details->>'email', ''),
        'auth_account_deleted', coalesce((v_final_details->>'auth_account_deleted')::boolean, false),
        'profile_removed', coalesce((v_final_details->>'profile_removed')::boolean, false)
      );
    end if;
    raise exception 'Deletion operation was not found or does not match the target' using errcode = '55000';
  end if;

  if v_operation.status = 'aborted' then
    return jsonb_build_object(
      'status', 'aborted',
      'operation_id', p_operation_id
    );
  end if;

  if v_operation.status = 'finalized' then
    select exists (
      select 1
      from auth.users au
      where au.id = p_target_user_id
    )
    into v_auth_exists;

    if v_auth_exists then
      return jsonb_build_object(
        'status', 'auth_present',
        'operation_id', p_operation_id
      );
    end if;

    select ae.details
      into v_final_details
    from public.audit_events ae
    where ae.event_type = 'staff.deleted'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
    order by ae.occurred_at desc, ae.id desc
    limit 1;

    if found then
      return jsonb_build_object(
        'status', 'already_finalized',
        'operation_id', p_operation_id,
        'email', nullif(v_final_details->>'email', ''),
        'auth_account_deleted', coalesce((v_final_details->>'auth_account_deleted')::boolean, false),
        'profile_removed', coalesce((v_final_details->>'profile_removed')::boolean, false)
      );
    end if;

    return jsonb_build_object(
      'status', 'already_finalized',
      'operation_id', p_operation_id,
      'email', nullif(v_operation.details->>'email', ''),
      'auth_account_deleted', coalesce((v_operation.details->>'auth_exists')::boolean, false),
      'profile_removed', coalesce((v_operation.details->>'profile_exists')::boolean, false)
    );
  end if;

  select exists (
    select 1
    from auth.users au
    where au.id = p_target_user_id
  )
  into v_auth_exists;

  if v_auth_exists then
    return jsonb_build_object(
      'status', 'auth_present',
      'operation_id', p_operation_id
    );
  end if;

  v_target_is_active_superadmin := coalesce((v_operation.details->>'target_is_active_superadmin')::boolean, false);

  if not v_target_is_active_superadmin then
    select exists (
      select 1
      from public.staff_profiles sp
      join public.staff_role_assignments sra on sra.user_id = sp.user_id
      where sp.user_id = p_target_user_id
        and sp.active = true
        and sra.role = 'superadmin'::public.app_role
        and sra.active = true
    )
    into v_target_is_active_superadmin;
  end if;

  if v_target_is_active_superadmin then
    select count(distinct sp.user_id)
      into v_remaining_superadmins
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    join auth.users au on au.id = sp.user_id
    where sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
      and sp.user_id <> p_target_user_id
      and not exists (
        select 1
        from public.staff_deletion_reservations r
        where r.target_user_id = sp.user_id
          and r.status = 'prepared'
      );

    if coalesce(v_remaining_superadmins, 0) < 1 then
      return jsonb_build_object(
        'status', 'last_superadmin',
        'operation_id', p_operation_id
      );
    end if;
  end if;

  v_details := v_operation.details;
  v_target_email := nullif(v_details->>'email', '');
  v_target_name := nullif(v_details->>'full_name', '');
  v_target_active := case
    when (v_details ? 'profile_active')
      and jsonb_typeof(v_details->'profile_active') <> 'null'
      then (v_details->>'profile_active')::boolean
    else null
  end;
  v_profile_removed := coalesce((v_details->>'profile_exists')::boolean, false);
  v_roles := case
    when jsonb_typeof(v_details->'roles') = 'array' then v_details->'roles'
    else '[]'::jsonb
  end;
  v_auth_account_deleted := coalesce((v_details->>'auth_exists')::boolean, false);

  select exists (
    select 1
    from public.staff_profiles sp
    where sp.user_id = p_target_user_id
  )
  into v_current_profile_exists;

  v_profile_removed := v_profile_removed or v_current_profile_exists;

  delete from public.staff_role_assignments
  where user_id = p_target_user_id;

  delete from public.staff_profiles
  where user_id = p_target_user_id;

  if not exists (
    select 1
    from public.audit_events ae
    where ae.event_type = 'staff.deleted'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
  ) then
    insert into public.audit_events (
      actor_user_id, event_type, entity_type, entity_id, details
    ) values (
      case
        when exists (select 1 from auth.users au where au.id = p_actor_user_id)
          then p_actor_user_id
        else null
      end,
      'staff.deleted',
      'staff_profile',
      p_target_user_id::text,
      jsonb_build_object(
        'operation_id', p_operation_id,
        'actor_user_id', p_actor_user_id,
        'email', v_target_email,
        'full_name', v_target_name,
        'profile_active', v_target_active,
        'roles', v_roles,
        'profile_removed', v_profile_removed,
        'auth_account_deleted', v_auth_account_deleted
      )
    );
  end if;

  update public.staff_deletion_reservations
  set status = 'finalized',
      updated_at = now()
  where operation_id = p_operation_id
    and target_user_id = p_target_user_id
    and status = 'prepared';

  return jsonb_build_object(
    'status', 'finalized',
    'operation_id', p_operation_id,
    'email', v_target_email,
    'auth_account_deleted', v_auth_account_deleted,
    'profile_removed', v_profile_removed
  );
end;
$$;

create or replace function public.abort_staff_deletion(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.staff_deletion_reservations%rowtype;
  v_final_details jsonb;
  v_snapshot_profile_exists boolean;
  v_current_profile_exists boolean;
  v_auth_exists boolean;
begin
  if p_operation_id is null or p_actor_user_id is null or p_target_user_id is null then
    raise exception 'Operation, actor, and target user are required';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'You cannot delete your own account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(712041, 1);

  if not exists (
    select 1
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id
      and sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  ) then
    raise exception 'Active SuperAdmin required' using errcode = '42501';
  end if;

  select r.*
    into v_operation
  from public.staff_deletion_reservations r
  where r.operation_id = p_operation_id
    and r.actor_user_id = p_actor_user_id
    and r.target_user_id = p_target_user_id;

  if not found then
    select ae.details
      into v_final_details
    from public.audit_events ae
    where ae.event_type = 'staff.deleted'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
    order by ae.occurred_at desc, ae.id desc
    limit 1;

    if found then
      select exists (
        select 1
        from auth.users au
        where au.id = p_target_user_id
      )
      into v_auth_exists;

      if v_auth_exists then
        return jsonb_build_object(
          'status', 'state_uncertain',
          'operation_id', p_operation_id
        );
      end if;

      return jsonb_build_object(
        'status', 'already_finalized',
        'operation_id', p_operation_id,
        'email', nullif(v_final_details->>'email', ''),
        'auth_account_deleted', coalesce((v_final_details->>'auth_account_deleted')::boolean, false),
        'profile_removed', coalesce((v_final_details->>'profile_removed')::boolean, false)
      );
    end if;
    raise exception 'Deletion operation was not found or does not match the target' using errcode = '55000';
  end if;

  if v_operation.status = 'finalized' then
    select exists (
      select 1
      from auth.users au
      where au.id = p_target_user_id
    )
    into v_auth_exists;

    if v_auth_exists then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    select ae.details
      into v_final_details
    from public.audit_events ae
    where ae.event_type = 'staff.deleted'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
    order by ae.occurred_at desc, ae.id desc
    limit 1;

    if found then
      return jsonb_build_object(
        'status', 'already_finalized',
        'operation_id', p_operation_id,
        'email', nullif(v_final_details->>'email', ''),
        'auth_account_deleted', coalesce((v_final_details->>'auth_account_deleted')::boolean, false),
        'profile_removed', coalesce((v_final_details->>'profile_removed')::boolean, false)
      );
    end if;

    return jsonb_build_object(
      'status', 'already_finalized',
      'operation_id', p_operation_id,
      'email', nullif(v_operation.details->>'email', ''),
      'auth_account_deleted', coalesce((v_operation.details->>'auth_exists')::boolean, false),
      'profile_removed', coalesce((v_operation.details->>'profile_exists')::boolean, false)
    );
  end if;

  if v_operation.status = 'aborted' then
    return jsonb_build_object(
      'status', 'already_aborted',
      'operation_id', p_operation_id
    );
  end if;

  select exists (
    select 1
    from auth.users au
    where au.id = p_target_user_id
  )
  into v_auth_exists;

  if not v_auth_exists then
    return jsonb_build_object(
      'status', 'auth_missing',
      'operation_id', p_operation_id
    );
  end if;

  v_snapshot_profile_exists := coalesce((v_operation.details->>'profile_exists')::boolean, false);

  select exists (
    select 1
    from public.staff_profiles sp
    where sp.user_id = p_target_user_id
  )
  into v_current_profile_exists;

  if v_current_profile_exists <> v_snapshot_profile_exists then
    return jsonb_build_object(
      'status', 'state_uncertain',
      'operation_id', p_operation_id
    );
  end if;

  if not exists (
    select 1
    from public.audit_events ae
    where ae.event_type = 'staff.deletion_failed'
      and ae.entity_type = 'staff_profile'
      and ae.entity_id = p_target_user_id::text
      and ae.details->>'operation_id' = p_operation_id::text
      and ae.details->>'actor_user_id' = p_actor_user_id::text
  ) then
    insert into public.audit_events (
      actor_user_id, event_type, entity_type, entity_id, details
    ) values (
      case
        when exists (select 1 from auth.users au where au.id = p_actor_user_id)
          then p_actor_user_id
        else null
      end,
      'staff.deletion_failed',
      'staff_profile',
      p_target_user_id::text,
      v_operation.details || jsonb_build_object(
        'operation_id', p_operation_id,
        'failure', 'auth_account_deletion_failed'
      )
    );
  end if;

  update public.staff_deletion_reservations
  set status = 'aborted',
      updated_at = now()
  where operation_id = p_operation_id
    and target_user_id = p_target_user_id
    and status = 'prepared';

  return jsonb_build_object(
    'status', 'released',
    'operation_id', p_operation_id
  );
end;
$$;

create or replace function public.recover_staff_deletion(
  p_operation_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation public.staff_deletion_reservations%rowtype;
  v_snapshot_profile_exists boolean;
  v_current_profile_exists boolean;
  v_current_profile public.staff_profiles%rowtype;
  v_snapshot_roles jsonb;
  v_current_roles jsonb;
  v_target_is_active_superadmin boolean := false;
  v_remaining_superadmins bigint;
  v_auth_exists boolean;
  v_final_result jsonb;
begin
  if p_operation_id is null or p_actor_user_id is null or p_target_user_id is null then
    raise exception 'Operation, actor, and target user are required';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception 'You cannot delete your own account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(712041, 1);

  if not exists (
    select 1
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id
      and sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  ) then
    raise exception 'Active SuperAdmin required' using errcode = '42501';
  end if;

  select r.*
    into v_operation
  from public.staff_deletion_reservations r
  where r.operation_id = p_operation_id
    and r.actor_user_id = p_actor_user_id
    and r.target_user_id = p_target_user_id;

  if not found then
    return jsonb_build_object(
      'status', 'not_found'
    );
  end if;

  if v_operation.status = 'aborted' then
    return jsonb_build_object(
      'status', 'aborted',
      'operation_id', p_operation_id
    );
  end if;

  if v_operation.status = 'finalized' then
    select exists (
      select 1
      from auth.users au
      where au.id = p_target_user_id
    )
    into v_auth_exists;

    if v_auth_exists then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    return public.finalize_staff_deletion(
      v_operation.operation_id,
      v_operation.actor_user_id,
      p_target_user_id
    );
  end if;

  select exists (
    select 1
    from auth.users au
    where au.id = p_target_user_id
  )
  into v_auth_exists;

  if jsonb_typeof(v_operation.details->'profile_exists') is distinct from 'boolean' then
    return jsonb_build_object(
      'status', 'state_uncertain',
      'operation_id', p_operation_id
    );
  end if;

  v_snapshot_profile_exists := (v_operation.details->>'profile_exists')::boolean;

  select sp.*
    into v_current_profile
  from public.staff_profiles sp
  where sp.user_id = p_target_user_id;
  v_current_profile_exists := found;

  if not v_current_profile_exists then
    if v_auth_exists or not v_snapshot_profile_exists then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;
  else
    if not v_snapshot_profile_exists then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    if v_operation.details->>'full_name' is distinct from v_current_profile.full_name then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    if jsonb_typeof(v_operation.details->'profile_active') is distinct from 'boolean'
      or (v_operation.details->>'profile_active')::boolean is distinct from v_current_profile.active then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    if (v_operation.details ? 'profile_email')
      and nullif(v_operation.details->>'profile_email', '') is distinct from nullif(v_current_profile.email, '') then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    if (v_operation.details ? 'profile_staff_number')
      and nullif(v_operation.details->>'profile_staff_number', '') is distinct from nullif(v_current_profile.staff_number, '') then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    if jsonb_typeof(v_operation.details->'roles') is distinct from 'array' then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;

    v_snapshot_roles := v_operation.details->'roles';

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'role', sra.role::text,
          'office_id', sra.office_id,
          'active', sra.active
        ) order by sra.created_at, sra.id
      ),
      '[]'::jsonb
    )
    into v_current_roles
    from public.staff_role_assignments sra
    where sra.user_id = p_target_user_id;

    if v_current_roles is distinct from v_snapshot_roles then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;
  end if;

  if not v_auth_exists then
    v_final_result := public.finalize_staff_deletion(
      v_operation.operation_id,
      v_operation.actor_user_id,
      p_target_user_id
    );
    if v_final_result->>'status' = 'auth_present' then
      return jsonb_build_object(
        'status', 'state_uncertain',
        'operation_id', p_operation_id
      );
    end if;
    return v_final_result;
  end if;

  v_target_is_active_superadmin := v_current_profile.active and exists (
    select 1
    from public.staff_role_assignments sra
    where sra.user_id = p_target_user_id
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  );

  if v_target_is_active_superadmin then
    select count(distinct sp.user_id)
      into v_remaining_superadmins
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    join auth.users au on au.id = sp.user_id
    where sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
      and sp.user_id <> p_target_user_id
      and not exists (
        select 1
        from public.staff_deletion_reservations r
        where r.target_user_id = sp.user_id
          and r.status = 'prepared'
      );

    if coalesce(v_remaining_superadmins, 0) < 1 then
      return jsonb_build_object(
        'status', 'last_superadmin',
        'operation_id', p_operation_id
      );
    end if;
  end if;

  return jsonb_build_object(
    'status', 'auth_present',
    'operation_id', p_operation_id
  );
end;
$$;

create or replace function public.find_staff_deletion_operation(
  p_actor_user_id uuid,
  p_target_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid;
  v_status text;
  v_actor_user_id uuid;
begin
  if p_actor_user_id is null or p_target_user_id is null then
    raise exception 'Actor and target user are required';
  end if;

  if not exists (
    select 1
    from public.staff_profiles sp
    join public.staff_role_assignments sra on sra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id
      and sp.active = true
      and sra.role = 'superadmin'::public.app_role
      and sra.active = true
  ) then
    raise exception 'Active SuperAdmin required' using errcode = '42501';
  end if;

  select r.operation_id, r.status, r.actor_user_id
    into v_operation_id, v_status, v_actor_user_id
  from public.staff_deletion_reservations r
  where r.target_user_id = p_target_user_id
  order by
    case r.status
      when 'prepared' then 0
      when 'finalized' then 1
      else 2
    end,
    r.created_at desc,
    r.operation_id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'status', 'not_found'
    );
  end if;

  return jsonb_build_object(
    'status', 'found',
    'operation_id', v_operation_id,
    'operation_status', v_status,
    'actor_user_id', v_actor_user_id
  );
end;
$$;

revoke all on function public.prepare_staff_deletion(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finalize_staff_deletion(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.abort_staff_deletion(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.recover_staff_deletion(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.find_staff_deletion_operation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.prepare_staff_deletion(uuid, uuid) to service_role;
grant execute on function public.finalize_staff_deletion(uuid, uuid, uuid) to service_role;
grant execute on function public.abort_staff_deletion(uuid, uuid, uuid) to service_role;
grant execute on function public.recover_staff_deletion(uuid, uuid, uuid) to service_role;
grant execute on function public.find_staff_deletion_operation(uuid, uuid) to service_role;

commit;
