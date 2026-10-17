create or replace function public.manage_institutional_setup(p_actor_user_id uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_id uuid; v_department_id uuid; v_code text; v_name text; v_active boolean;
  v_entity_type text; v_entity_id text; v_details jsonb; v_cadre text; v_description text; v_order integer;
  v_academic_session text; v_opens timestamptz; v_closes timestamptz;
begin
  if p_actor_user_id is null or not exists (
    select 1 from public.staff_profiles sp join public.staff_role_assignments ra on ra.user_id=sp.user_id
    where sp.user_id=p_actor_user_id and sp.active=true and ra.active=true and ra.role='superadmin'
  ) then raise exception 'SuperAdmin access required' using errcode='42501'; end if;
  case p_action
  when 'department_save' then
    v_id:=nullif(p_payload->>'id','')::uuid; v_code:=upper(trim(coalesce(p_payload->>'code',''))); v_name:=trim(coalesce(p_payload->>'name',''));
    if v_code='' or v_name='' or length(v_code)>30 or length(v_name)>160 then raise exception 'Department code and name are required'; end if;
    if v_id is null then insert into public.departments(code,name,active) values(v_code,v_name,true) returning id into v_id;
    else update public.departments set code=v_code,name=v_name where id=v_id returning id into v_id; if v_id is null then raise exception 'Department not found'; end if; end if;
    v_entity_type:='department'; v_details:=jsonb_build_object('action',p_action,'code',v_code,'name',v_name);
  when 'department_toggle' then
    v_id:=(p_payload->>'id')::uuid; v_active:=(p_payload->>'active')::boolean;
    update public.departments set active=v_active where id=v_id returning id,code into v_id,v_code; if v_id is null then raise exception 'Department not found'; end if;
    v_entity_type:='department'; v_details:=jsonb_build_object('action',p_action,'active',v_active,'code',v_code);
  when 'programme_save' then
    v_id:=nullif(p_payload->>'id','')::uuid; v_department_id:=nullif(p_payload->>'department_id','')::uuid;
    v_code:=upper(trim(coalesce(p_payload->>'code',''))); v_name:=trim(coalesce(p_payload->>'name','')); v_cadre:=nullif(trim(coalesce(p_payload->>'cadre','')),'');
    if v_department_id is null or v_code='' or v_name='' or length(v_code)>30 or length(v_name)>160 then raise exception 'Department, programme code and name are required'; end if;
    if not exists(select 1 from public.departments where id=v_department_id and active=true) then raise exception 'Choose an active department'; end if;
    if v_id is null then insert into public.programmes(department_id,code,name,cadre,active) values(v_department_id,v_code,v_name,v_cadre,true) returning id into v_id;
    else update public.programmes set department_id=v_department_id,code=v_code,name=v_name,cadre=v_cadre where id=v_id returning id into v_id; if v_id is null then raise exception 'Programme not found'; end if; end if;
    v_entity_type:='programme'; v_details:=jsonb_build_object('action',p_action,'department_id',v_department_id,'code',v_code,'name',v_name);
  when 'programme_toggle' then
    v_id:=(p_payload->>'id')::uuid; v_active:=(p_payload->>'active')::boolean;
    update public.programmes set active=v_active where id=v_id returning id,code into v_id,v_code; if v_id is null then raise exception 'Programme not found'; end if;
    v_entity_type:='programme'; v_details:=jsonb_build_object('action',p_action,'active',v_active,'code',v_code);
  when 'office_save' then
    v_id:=nullif(p_payload->>'id','')::uuid; v_code:=upper(trim(coalesce(p_payload->>'code',''))); v_name:=trim(coalesce(p_payload->>'name',''));
    v_description:=nullif(trim(coalesce(p_payload->>'description','')),''); v_order:=coalesce(nullif(p_payload->>'display_order','')::integer,100);
    if v_code='' or v_name='' or length(v_code)>30 or length(v_name)>160 then raise exception 'Office code and name are required'; end if;
    if v_id is null then insert into public.clearance_offices(code,name,description,active,display_order) values(v_code,v_name,v_description,true,v_order) returning id into v_id;
    else update public.clearance_offices set code=v_code,name=v_name,description=v_description,display_order=v_order where id=v_id returning id into v_id; if v_id is null then raise exception 'Office not found'; end if; end if;
    v_entity_type:='clearance_office'; v_details:=jsonb_build_object('action',p_action,'code',v_code,'name',v_name);
  when 'office_toggle' then
    v_id:=(p_payload->>'id')::uuid; v_active:=(p_payload->>'active')::boolean;
    update public.clearance_offices set active=v_active where id=v_id returning id,code into v_id,v_code; if v_id is null then raise exception 'Office not found'; end if;
    v_entity_type:='clearance_office'; v_details:=jsonb_build_object('action',p_action,'active',v_active,'code',v_code);
  when 'session_save' then
    v_id:=nullif(p_payload->>'id','')::uuid; v_name:=trim(coalesce(p_payload->>'name','')); v_academic_session:=trim(coalesce(p_payload->>'academic_session',''));
    v_opens:=nullif(p_payload->>'opens_at','')::timestamptz; v_closes:=nullif(p_payload->>'closes_at','')::timestamptz;
    if v_name='' or v_academic_session='' or length(v_name)>160 or length(v_academic_session)>30 then raise exception 'Session name and academic session are required'; end if;
    if v_opens is not null and v_closes is not null and v_closes<=v_opens then raise exception 'Closing time must be after opening time'; end if;
    if v_id is null then insert into public.clearance_sessions(name,academic_session,opens_at,closes_at,active) values(v_name,v_academic_session,v_opens,v_closes,false) returning id into v_id;
    else update public.clearance_sessions set name=v_name,academic_session=v_academic_session,opens_at=v_opens,closes_at=v_closes where id=v_id returning id into v_id; if v_id is null then raise exception 'Academic session not found'; end if; end if;
    v_entity_type:='clearance_session'; v_details:=jsonb_build_object('action',p_action,'name',v_name,'academic_session',v_academic_session);
  when 'session_activate' then
    v_id:=(p_payload->>'id')::uuid; if not exists(select 1 from public.clearance_sessions where id=v_id) then raise exception 'Academic session not found'; end if;
    update public.clearance_sessions set active=false where active=true and id<>v_id;
    update public.clearance_sessions set active=true where id=v_id returning name,academic_session into v_name,v_academic_session;
    v_entity_type:='clearance_session'; v_details:=jsonb_build_object('action',p_action,'name',v_name,'academic_session',v_academic_session,'active',true);
  when 'session_deactivate' then
    v_id:=(p_payload->>'id')::uuid; update public.clearance_sessions set active=false where id=v_id returning name,academic_session into v_name,v_academic_session;
    if not found then raise exception 'Academic session not found'; end if;
    v_entity_type:='clearance_session'; v_details:=jsonb_build_object('action',p_action,'name',v_name,'academic_session',v_academic_session,'active',false);
  else raise exception 'Unsupported institutional setup action';
  end case;
  v_entity_id:=v_id::text;
  insert into public.audit_events(actor_user_id,event_type,entity_type,entity_id,details,occurred_at)
  values(p_actor_user_id,'institutional_setup.'||p_action,v_entity_type,v_entity_id,v_details,now());
  return jsonb_build_object('success',true,'id',v_id);
end; $function$;
revoke all on function public.manage_institutional_setup(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.manage_institutional_setup(uuid,text,jsonb) to service_role;

