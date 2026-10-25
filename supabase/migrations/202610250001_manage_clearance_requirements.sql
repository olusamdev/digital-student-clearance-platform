create or replace function public.manage_clearance_requirements(p_actor_user_id uuid, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_session_id uuid;
  v_office_id uuid;
  v_department_id uuid;
  v_programme_id uuid;
  v_enabled boolean;
  v_required boolean;
  v_instructions text;
  v_order integer;
  v_result jsonb;
begin
  if not exists (
    select 1 from public.staff_profiles sp
    join public.staff_role_assignments ra on ra.user_id = sp.user_id
    where sp.user_id = p_actor_user_id and sp.active and ra.active and ra.role = 'superadmin'
  ) then raise exception 'SuperAdmin access required' using errcode = '42501'; end if;

  if p_action = 'list' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'session_id', r.session_id, 'session_name', s.name, 'academic_session', s.academic_session,
      'office_id', r.office_id, 'office_name', o.name, 'department_id', r.department_id, 'department_name', d.name,
      'programme_id', r.programme_id, 'programme_name', p.name, 'required', r.required, 'enabled', r.enabled,
      'instructions', r.instructions, 'display_order', r.display_order
    ) order by s.created_at desc, r.display_order, o.name), '[]'::jsonb)
    into v_result
    from public.clearance_requirements r
    join public.clearance_sessions s on s.id = r.session_id
    join public.clearance_offices o on o.id = r.office_id
    left join public.departments d on d.id = r.department_id
    left join public.programmes p on p.id = r.programme_id;
    return jsonb_build_object('success', true, 'requirements', v_result);
  elsif p_action = 'save' then
    v_id := nullif(p_payload->>'id', '')::uuid;
    v_session_id := nullif(p_payload->>'session_id', '')::uuid;
    v_office_id := nullif(p_payload->>'office_id', '')::uuid;
    v_department_id := nullif(p_payload->>'department_id', '')::uuid;
    v_programme_id := nullif(p_payload->>'programme_id', '')::uuid;
    v_required := coalesce((p_payload->>'required')::boolean, true);
    v_enabled := coalesce((p_payload->>'enabled')::boolean, false);
    v_instructions := nullif(trim(coalesce(p_payload->>'instructions', '')), '');
    v_order := coalesce(nullif(p_payload->>'display_order', '')::integer, 100);
    if v_session_id is null or v_office_id is null then raise exception 'Academic session and office are required'; end if;
    if not exists (select 1 from public.clearance_sessions where id = v_session_id) then raise exception 'Invalid academic session'; end if;
    if not exists (select 1 from public.clearance_offices where id = v_office_id and active) then raise exception 'Choose an active office'; end if;
    if v_department_id is not null and not exists (select 1 from public.departments where id = v_department_id and active) then raise exception 'Choose an active department'; end if;
    if v_programme_id is not null and (v_department_id is null or not exists (select 1 from public.programmes where id = v_programme_id and department_id = v_department_id and active)) then raise exception 'Programme must belong to the selected active department'; end if;
    if length(coalesce(v_instructions,'')) > 2000 or v_order < 0 or v_order > 10000 then raise exception 'Instructions or display order is outside allowed limits'; end if;
    if exists (select 1 from public.clearance_requirements r where r.session_id=v_session_id and r.office_id=v_office_id and r.department_id is not distinct from v_department_id and r.programme_id is not distinct from v_programme_id and r.id is distinct from v_id) then raise exception 'Requirement already exists for this session, office and scope'; end if;
    if v_id is null then
      insert into public.clearance_requirements(session_id,office_id,department_id,programme_id,required,enabled,instructions,display_order,created_by)
      values(v_session_id,v_office_id,v_department_id,v_programme_id,v_required,v_enabled,v_instructions,v_order,p_actor_user_id) returning id into v_id;
    else
      update public.clearance_requirements set session_id=v_session_id,office_id=v_office_id,department_id=v_department_id,programme_id=v_programme_id,required=v_required,enabled=v_enabled,instructions=v_instructions,display_order=v_order where id=v_id returning id into v_id;
      if v_id is null then raise exception 'Requirement not found'; end if;
    end if;
    insert into public.audit_events(actor_user_id,event_type,entity_type,entity_id,details,occurred_at)
    values(p_actor_user_id,'clearance_requirement.saved','clearance_requirement',v_id::text,jsonb_build_object('session_id',v_session_id,'office_id',v_office_id,'department_id',v_department_id,'programme_id',v_programme_id,'required',v_required,'enabled',v_enabled),now());
    return jsonb_build_object('success',true,'id',v_id);
  elsif p_action = 'toggle' then
    v_id := nullif(p_payload->>'id','')::uuid;
    v_enabled := (p_payload->>'enabled')::boolean;
    if v_id is null or v_enabled is null then raise exception 'Requirement and enabled status are required'; end if;
    update public.clearance_requirements set enabled=v_enabled where id=v_id;
    if not found then raise exception 'Requirement not found'; end if;
    insert into public.audit_events(actor_user_id,event_type,entity_type,entity_id,details,occurred_at)
    values(p_actor_user_id,'clearance_requirement.toggled','clearance_requirement',v_id::text,jsonb_build_object('enabled',v_enabled),now());
    return jsonb_build_object('success',true,'id',v_id,'enabled',v_enabled);
  else raise exception 'Unsupported requirements action';
  end if;
end; $$;

revoke all on function public.manage_clearance_requirements(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.manage_clearance_requirements(uuid,text,jsonb) to service_role;
