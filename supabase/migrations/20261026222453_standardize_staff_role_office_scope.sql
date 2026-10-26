BEGIN;
ALTER TABLE public.staff_role_assignments DROP CONSTRAINT IF EXISTS staff_role_assignments_department_scope_check;
DROP INDEX IF EXISTS public.staff_role_assignments_one_active_hod_per_department_office;
UPDATE public.staff_role_assignments SET role='clearance_officer'::public.app_role
WHERE role IN ('unit_head'::public.app_role,'head_of_department'::public.app_role);
UPDATE public.staff_role_assignments SET role='bursar'::public.app_role, office_id=NULL, department_id=NULL
WHERE role='clearance_officer'::public.app_role
AND office_id IN (SELECT id FROM public.clearance_offices WHERE code='BURSARY');
ALTER TABLE public.staff_role_assignments ADD CONSTRAINT staff_role_assignments_scope_check CHECK (
  (role='clearance_officer'::public.app_role AND office_id IS NOT NULL)
  OR (role<>'clearance_officer'::public.app_role AND office_id IS NULL AND department_id IS NULL)
);
CREATE UNIQUE INDEX staff_role_assignments_one_active_hod_per_department_office
ON public.staff_role_assignments(department_id,office_id)
WHERE role='clearance_officer'::public.app_role AND active=true AND department_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_staff_role_assignment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_office_code text; v_office_active boolean;
BEGIN
  IF NEW.role IN ('unit_head'::public.app_role,'head_of_department'::public.app_role) THEN
    RAISE EXCEPTION 'Use the Clearance Officer role and select the appropriate clearance office';
  END IF;
  IF NEW.role='clearance_officer'::public.app_role THEN
    IF NEW.office_id IS NULL THEN RAISE EXCEPTION 'Clearance Officer accounts require a clearance office'; END IF;
    SELECT co.code,co.active INTO v_office_code,v_office_active FROM public.clearance_offices co WHERE co.id=NEW.office_id;
    IF v_office_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Selected clearance office is missing or inactive'; END IF;
    IF v_office_code NOT IN ('HOD','EO','LB','LAB','DU','DM','SM') THEN RAISE EXCEPTION 'Choose HOD, EO, LB, LAB, DU, DM, or SM for a Clearance Officer account'; END IF;
    IF v_office_code='HOD' AND NEW.department_id IS NULL THEN RAISE EXCEPTION 'HOD office assignments require a department'; END IF;
    IF v_office_code<>'HOD' AND NEW.department_id IS NOT NULL THEN RAISE EXCEPTION 'Only HOD office assignments may be scoped to a department'; END IF;
  ELSE
    IF NEW.office_id IS NOT NULL OR NEW.department_id IS NOT NULL THEN RAISE EXCEPTION 'This role is standalone and must not have a clearance office or department'; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS enforce_staff_role_assignment_scope ON public.staff_role_assignments;
CREATE TRIGGER enforce_staff_role_assignment_scope
BEFORE INSERT OR UPDATE OF role,office_id,department_id ON public.staff_role_assignments
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_role_assignment_scope();

CREATE OR REPLACE FUNCTION public.notify_clearance_request_submitted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_student_id uuid; v_department_id uuid; v_office_id uuid; v_office_name text; v_office_code text;
BEGIN
  IF NEW.status='requested'::public.clearance_status AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    SELECT ss.student_id,sr.department_id,req.office_id,co.name,co.code
    INTO v_student_id,v_department_id,v_office_id,v_office_name,v_office_code
    FROM public.session_students ss JOIN public.student_records sr ON sr.id=ss.student_id
    JOIN public.clearance_requirements req ON req.id=NEW.requirement_id
    JOIN public.clearance_offices co ON co.id=req.office_id
    WHERE ss.id=NEW.session_student_id;
    INSERT INTO public.notifications(recipient_user_id,clearance_request_id,channel,notification_type,title,message,delivery_status)
    SELECT DISTINCT ra.user_id,NEW.id,'in_app','clearance_requested','New clearance request',
      'A student has requested clearance from '||v_office_name||'.','queued'
    FROM public.staff_role_assignments ra
    JOIN public.staff_profiles sp ON sp.user_id=ra.user_id AND sp.active=true
    WHERE ra.active=true AND ra.role='clearance_officer'::public.app_role
      AND ra.office_id=v_office_id AND (v_office_code<>'HOD' OR ra.department_id=v_department_id);
    INSERT INTO public.audit_events(actor_student_id,event_type,entity_type,entity_id,details)
    VALUES(v_student_id,'clearance.requested','clearance_request',NEW.id::text,
      jsonb_build_object('office_id',v_office_id,'requirement_id',NEW.requirement_id,'session_student_id',NEW.session_student_id));
  END IF;
  RETURN NEW;
END;
$function$;

DO $migration$
DECLARE v_definition text; v_old text;
BEGIN
  v_definition:=pg_get_functiondef('public.manage_clearance_workflow(uuid,text,jsonb)'::regprocedure);
  v_old:=$old$AND ra.role IN ('superadmin','admin','clearance_officer','unit_head','head_of_department','provost','registrar')$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected manage_clearance_workflow role gate was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$AND ra.role IN ('superadmin','admin','clearance_officer','provost','registrar')$new$);
  v_old:=$old$          OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                     WHERE ra.user_id = p_actor_user_id AND ra.active = true
                       AND ra.role IN ('clearance_officer','unit_head')
                       AND ra.office_id = req.office_id)
          OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                     WHERE ra.user_id = p_actor_user_id AND ra.active = true
                       AND ra.role = 'head_of_department'
                       AND ra.office_id = req.office_id
                       AND ra.department_id = sr.department_id)$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected manage_clearance_workflow queue scope was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$          OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                     WHERE ra.user_id = p_actor_user_id AND ra.active = true
                       AND ra.role = 'clearance_officer'
                       AND ra.office_id = req.office_id
                       AND (co.code <> 'HOD' OR ra.department_id = sr.department_id))$new$);
  v_old:=$old$      OR EXISTS (SELECT 1
                 FROM public.staff_role_assignments ra
                 JOIN public.session_students ss_scope ON ss_scope.id=v_session_student_id
                 JOIN public.student_records sr_scope ON sr_scope.id=ss_scope.student_id
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND ra.role='head_of_department'
                   AND ra.office_id=v_office_id
                   AND ra.department_id=sr_scope.department_id)
      OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND ra.role IN ('clearance_officer','unit_head') AND ra.office_id=v_office_id)$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected manage_clearance_workflow decision scope was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$      OR EXISTS (SELECT 1
                 FROM public.staff_role_assignments ra
                 JOIN public.clearance_offices office_scope ON office_scope.id=ra.office_id
                 JOIN public.session_students ss_scope ON ss_scope.id=v_session_student_id
                 JOIN public.student_records sr_scope ON sr_scope.id=ss_scope.student_id
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND ra.role='clearance_officer' AND ra.office_id=v_office_id
                   AND (office_scope.code<>'HOD' OR ra.department_id=sr_scope.department_id))$new$);
  v_old:=$old$ORDER BY CASE ra.role WHEN 'head_of_department' THEN 1 WHEN 'unit_head' THEN 2 WHEN 'clearance_officer' THEN 3 WHEN 'admin' THEN 4 ELSE 5 END$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected manage_clearance_workflow role ordering was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$ORDER BY CASE ra.role WHEN 'clearance_officer' THEN 1 WHEN 'admin' THEN 2 ELSE 5 END$new$);
  EXECUTE v_definition;

  v_definition:=pg_get_functiondef('public.can_access_clearance_request(uuid)'::regprocedure);
  v_old:=$old$    or exists (
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
    )$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected clearance-request RLS scope was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$    or exists (
      select 1
      from public.clearance_requests cr
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.clearance_offices co on co.id = req.office_id
      join public.session_students ss on ss.id = cr.session_student_id
      join public.student_records sr on sr.id = ss.student_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role = 'clearance_officer'::public.app_role
      where cr.id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
        and (co.code <> 'HOD' or sra.department_id = sr.department_id)
    )$new$);
  EXECUTE v_definition;

  v_definition:=pg_get_functiondef('public.can_access_session_student(uuid)'::regprocedure);
  v_old:=$old$    or exists (
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
    )$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected session-student RLS scope was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$    or exists (
      select 1
      from public.clearance_requests cr
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.clearance_offices co on co.id = req.office_id
      join public.session_students ss_scope on ss_scope.id = cr.session_student_id
      join public.student_records sr on sr.id = ss_scope.student_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role = 'clearance_officer'::public.app_role
      where cr.session_student_id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
        and (co.code <> 'HOD' or sra.department_id = sr.department_id)
    )$new$);
  EXECUTE v_definition;

  v_definition:=pg_get_functiondef('public.can_access_student_record(uuid)'::regprocedure);
  v_old:=$old$    or exists (
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
    )$old$;
  IF position(v_old IN v_definition)=0 THEN RAISE EXCEPTION 'Expected student-record RLS scope was not found'; END IF;
  v_definition:=replace(v_definition,v_old,$new$    or exists (
      select 1
      from public.session_students ss
      join public.clearance_requests cr on cr.session_student_id = ss.id
      join public.clearance_requirements req on req.id = cr.requirement_id
      join public.clearance_offices co on co.id = req.office_id
      join public.student_records sr_scope on sr_scope.id = ss.student_id
      join public.staff_role_assignments sra
        on sra.office_id = req.office_id
       and sra.user_id = auth.uid()
       and sra.active = true
       and sra.role = 'clearance_officer'::public.app_role
      where ss.student_id = target_student_id
        and cr.status <> 'not_requested'::public.clearance_status
        and (co.code <> 'HOD' or sra.department_id = sr_scope.department_id)
    )$new$);
  EXECUTE v_definition;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.process_clearance_reminders()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_interval_hours integer:=24; v_request record; v_count integer:=0; v_recipients integer;
  v_office_id uuid; v_office_code text; v_department_id uuid;
BEGIN
  SELECT GREATEST(1,LEAST(720,COALESCE(NULLIF(setting_value #>> '{}','')::integer,24)))
  INTO v_interval_hours FROM public.app_settings WHERE setting_key='officer_reminder_interval_hours';
  v_interval_hours:=COALESCE(v_interval_hours,24);
  FOR v_request IN
    SELECT cr.id,cr.requirement_id,cr.session_student_id,cr.status,cr.requested_at,cr.created_at
    FROM public.clearance_requests cr
    WHERE cr.status IN ('requested'::public.clearance_status,'needs_attention'::public.clearance_status)
      AND COALESCE(cr.requested_at,cr.created_at)<=now()-make_interval(hours=>v_interval_hours)
      AND (cr.last_reminded_at IS NULL OR cr.last_reminded_at<=now()-make_interval(hours=>v_interval_hours))
      AND NOT EXISTS (SELECT 1 FROM public.clearance_comments cc WHERE cc.clearance_request_id=cr.id)
  LOOP
    SELECT req.office_id,co.code,sr.department_id INTO v_office_id,v_office_code,v_department_id
    FROM public.clearance_requirements req JOIN public.clearance_offices co ON co.id=req.office_id
    JOIN public.session_students ss ON ss.id=v_request.session_student_id
    JOIN public.student_records sr ON sr.id=ss.student_id WHERE req.id=v_request.requirement_id;
    INSERT INTO public.notifications(recipient_user_id,clearance_request_id,channel,notification_type,title,message,delivery_status)
    SELECT DISTINCT ra.user_id,v_request.id,'in_app','clearance_reminder','Clearance request needs attention',
      'A clearance request has remained uncleared for at least '||v_interval_hours||' hours and has no remarks. Please review it.','queued'
    FROM public.staff_role_assignments ra JOIN public.staff_profiles sp ON sp.user_id=ra.user_id AND sp.active=true
    WHERE ra.active=true AND ra.role='clearance_officer'::public.app_role AND ra.office_id=v_office_id
      AND (v_office_code<>'HOD' OR ra.department_id=v_department_id);
    GET DIAGNOSTICS v_recipients=ROW_COUNT;
    IF v_recipients>0 THEN
      UPDATE public.clearance_requests SET last_reminded_at=now(),reminder_count=reminder_count+1,updated_at=now() WHERE id=v_request.id;
      INSERT INTO public.audit_events(event_type,entity_type,entity_id,details)
      VALUES('clearance.reminder_sent','clearance_request',v_request.id::text,
        jsonb_build_object('interval_hours',v_interval_hours,'recipient_count',v_recipients));
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('success',true,'interval_hours',v_interval_hours,'requests_reminded',v_count);
END;
$function$;
COMMIT;
