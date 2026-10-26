BEGIN;
-- Re-establish role-specific office assignment rules.
DROP TRIGGER IF EXISTS enforce_staff_role_assignment_scope ON public.staff_role_assignments;
ALTER TABLE public.staff_role_assignments DROP CONSTRAINT IF EXISTS staff_role_assignments_scope_check;
DROP INDEX IF EXISTS public.staff_role_assignments_one_active_hod_per_department_office;

-- HOD is now a separate role; SAD remains an office under Clearance Officer.
UPDATE public.staff_role_assignments
SET role='head_of_department'::public.app_role
WHERE role='clearance_officer'::public.app_role
  AND office_id IN (SELECT id FROM public.clearance_offices WHERE code='HOD');

ALTER TABLE public.staff_role_assignments ADD CONSTRAINT staff_role_assignments_scope_check CHECK (
  (role='clearance_officer'::public.app_role AND office_id IS NOT NULL AND department_id IS NULL)
  OR (role='head_of_department'::public.app_role AND office_id IS NOT NULL AND department_id IS NOT NULL)
  OR (role NOT IN ('clearance_officer'::public.app_role,'head_of_department'::public.app_role)
      AND office_id IS NULL AND department_id IS NULL)
);

CREATE UNIQUE INDEX staff_role_assignments_one_active_hod_per_department_office
ON public.staff_role_assignments(department_id,office_id)
WHERE role='head_of_department'::public.app_role AND active=true AND department_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_staff_role_assignment_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_office_code text; v_office_active boolean;
BEGIN
  IF NEW.role='unit_head'::public.app_role THEN
    RAISE EXCEPTION 'Unit Head is not a separate role; use the assigned clearance role';
  ELSIF NEW.role='head_of_department'::public.app_role THEN
    IF NEW.office_id IS NULL THEN RAISE EXCEPTION 'Head of Department accounts require the HOD office'; END IF;
    SELECT co.code,co.active INTO v_office_code,v_office_active FROM public.clearance_offices co WHERE co.id=NEW.office_id;
    IF v_office_active IS DISTINCT FROM TRUE OR v_office_code IS DISTINCT FROM 'HOD' THEN
      RAISE EXCEPTION 'Head of Department accounts must use the active HOD office';
    END IF;
    IF NEW.department_id IS NULL THEN RAISE EXCEPTION 'Head of Department accounts require a department'; END IF;
  ELSIF NEW.role='clearance_officer'::public.app_role THEN
    IF NEW.office_id IS NULL THEN RAISE EXCEPTION 'Clearance Officer accounts require a clearance office'; END IF;
    SELECT co.code,co.active INTO v_office_code,v_office_active FROM public.clearance_offices co WHERE co.id=NEW.office_id;
    IF v_office_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Selected clearance office is missing or inactive'; END IF;
    IF v_office_code NOT IN ('EO','LB','LAB','DU','DM','SM','SAD') THEN
      RAISE EXCEPTION 'Choose EO, LB, LAB, DU, DM, SM, or SAD for a Clearance Officer account';
    END IF;
    IF NEW.department_id IS NOT NULL THEN RAISE EXCEPTION 'Only Head of Department accounts may be scoped to a department'; END IF;
  ELSE
    IF NEW.office_id IS NOT NULL OR NEW.department_id IS NOT NULL THEN
      RAISE EXCEPTION 'This role is standalone and must not have a clearance office or department';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER enforce_staff_role_assignment_scope
BEFORE INSERT OR UPDATE OF role,office_id,department_id ON public.staff_role_assignments
FOR EACH ROW EXECUTE FUNCTION public.enforce_staff_role_assignment_scope();

CREATE OR REPLACE FUNCTION public.manage_clearance_workflow(p_actor_user_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_request_id uuid;
  v_session_student_id uuid;
  v_office_id uuid;
  v_status public.clearance_status;
  v_role public.app_role;
  v_comment text;
  v_assent public.final_assent_status;
  v_remarks text;
  v_requests jsonb := '[]'::jsonb;
  v_assent_queue jsonb := '[]'::jsonb;
  v_completed_queue jsonb := '[]'::jsonb;
  v_interval_hours integer := 24;
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.staff_profiles sp
    JOIN public.staff_role_assignments ra ON ra.user_id = sp.user_id
    WHERE sp.user_id = p_actor_user_id AND sp.active = true AND ra.active = true
  ) THEN
    RAISE EXCEPTION 'Active staff account required' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'set_reminder_interval' THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                   WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role='superadmin') THEN
      RAISE EXCEPTION 'SuperAdmin access required to change reminder settings' USING ERRCODE = '42501';
    END IF;
    v_interval_hours := NULLIF(p_payload->>'interval_hours','')::integer;
    IF v_interval_hours IS NULL OR v_interval_hours < 1 OR v_interval_hours > 720 THEN
      RAISE EXCEPTION 'Reminder interval must be between 1 and 720 hours';
    END IF;
    INSERT INTO public.app_settings(setting_key,setting_value,description,updated_at,updated_by)
    VALUES('officer_reminder_interval_hours',to_jsonb(v_interval_hours),'Reminder interval for unresolved clearance requests',now(),p_actor_user_id)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now(),updated_by=p_actor_user_id;
    INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
    VALUES(p_actor_user_id,'clearance.reminder_interval_changed','app_setting','officer_reminder_interval_hours',
      jsonb_build_object('interval_hours',v_interval_hours));
    RETURN jsonb_build_object('success',true,'interval_hours',v_interval_hours);
  ELSIF p_action = 'list_queue' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.staff_role_assignments ra
      WHERE ra.user_id = p_actor_user_id AND ra.active = true
        AND ra.role IN ('superadmin','admin','clearance_officer','head_of_department','bursar','provost','registrar')
    ) THEN
      RAISE EXCEPTION 'This role cannot access the clearance workspace' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(q.row_json ORDER BY q.requested_at DESC NULLS LAST), '[]'::jsonb)
    INTO v_requests
    FROM (
      SELECT
        cr.requested_at,
        jsonb_build_object(
          'request_id', cr.id,
          'session_student_id', ss.id,
          'student_id', sr.id,
          'student_name', sr.full_name,
          'registration_number', sr.registration_number,
          'department', d.name,
          'programme', p.name,
          'session_name', cs.name,
          'academic_session', cs.academic_session,
          'office_id', co.id,
          'office_name', co.name,
          'office_code', co.code,
          'requirement_id', req.id,
          'instructions', req.instructions,
          'status', cr.status::text,
          'requested_at', cr.requested_at,
          'decision_at', cr.decision_at,
          'reminder_count', cr.reminder_count,
          'comments', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'id', cc.id, 'comment_text', cc.comment_text,
              'author_role', cc.author_role, 'created_at', cc.created_at
            ) ORDER BY cc.created_at)
            FROM public.clearance_comments cc
            WHERE cc.clearance_request_id = cr.id
          ), '[]'::jsonb)
        ) AS row_json
      FROM public.clearance_requests cr
      JOIN public.clearance_requirements req ON req.id = cr.requirement_id
      JOIN public.clearance_offices co ON co.id = req.office_id
      JOIN public.session_students ss ON ss.id = cr.session_student_id
      JOIN public.student_records sr ON sr.id = ss.student_id
      JOIN public.clearance_sessions cs ON cs.id = ss.session_id
      LEFT JOIN public.departments d ON d.id = sr.department_id
      LEFT JOIN public.programmes p ON p.id = sr.programme_id
      WHERE cr.status <> 'not_requested'::public.clearance_status
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_role_assignments superadmin_role
          WHERE superadmin_role.user_id = p_actor_user_id
            AND superadmin_role.active = true
            AND superadmin_role.role = 'superadmin'
        )
        AND (
          EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                  WHERE ra.user_id = p_actor_user_id AND ra.active = true
                    AND ra.role = 'admin')
          OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                     WHERE ra.user_id = p_actor_user_id AND ra.active = true
                       AND (
                         (ra.role = 'clearance_officer' AND ra.office_id = req.office_id AND co.code <> 'HOD')
                         OR (ra.role = 'head_of_department' AND ra.office_id = req.office_id AND co.code = 'HOD' AND ra.department_id = sr.department_id)
                         OR (ra.role = 'bursar' AND co.code = 'BURSARY')
                         OR (ra.role = 'registrar' AND co.code = 'REG')
                       ))
        )
    ) q;

    IF EXISTS (SELECT 1 FROM public.staff_role_assignments ra WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role='provost') THEN
      SELECT COALESCE(jsonb_agg(x.row_json ORDER BY x.session_name, x.student_name), '[]'::jsonb)
      INTO v_assent_queue
      FROM (
        SELECT
          cs.name AS session_name,
          sr.full_name AS student_name,
          jsonb_build_object(
            'session_student_id', ss.id,
            'student_id', sr.id,
            'student_name', sr.full_name,
            'registration_number', sr.registration_number,
            'department', d.name,
            'programme', p.name,
            'session_name', cs.name,
            'academic_session', cs.academic_session,
            'final_assent', ss.final_assent::text,
            'final_assent_remarks', ss.final_assent_remarks,
            'all_required_cleared', true
          ) AS row_json
        FROM public.session_students ss
        JOIN public.student_records sr ON sr.id=ss.student_id
        JOIN public.clearance_sessions cs ON cs.id=ss.session_id
        LEFT JOIN public.departments d ON d.id=sr.department_id
        LEFT JOIN public.programmes p ON p.id=sr.programme_id
        WHERE ss.final_assent IN ('pending'::public.final_assent_status, 'declined'::public.final_assent_status, 'revoked'::public.final_assent_status)
          AND EXISTS (
            SELECT 1 FROM public.clearance_requirements req
            WHERE req.session_id=ss.session_id AND req.enabled=true AND req.required=true
              AND (req.department_id IS NULL OR req.department_id=sr.department_id)
              AND (req.programme_id IS NULL OR req.programme_id=sr.programme_id)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM public.clearance_requirements req
            LEFT JOIN public.clearance_requests cr
              ON cr.requirement_id=req.id AND cr.session_student_id=ss.id
            WHERE req.session_id=ss.session_id AND req.enabled=true AND req.required=true
              AND (req.department_id IS NULL OR req.department_id=sr.department_id)
              AND (req.programme_id IS NULL OR req.programme_id=sr.programme_id)
              AND cr.status IS DISTINCT FROM 'cleared'::public.clearance_status
          )
      ) x;
    END IF;

    IF EXISTS (SELECT 1 FROM public.staff_role_assignments ra WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role IN ('registrar','superadmin','admin')) THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'session_student_id', ss.id,
        'student_name', sr.full_name,
        'registration_number', sr.registration_number,
        'department', d.name,
        'programme', p.name,
        'session_name', cs.name,
        'academic_session', cs.academic_session,
        'final_assent_at', ss.final_assent_at,
        'completed_at', ss.completed_at
      ) ORDER BY cs.name, sr.registration_number), '[]'::jsonb)
      INTO v_completed_queue
      FROM public.session_students ss
      JOIN public.student_records sr ON sr.id=ss.student_id
      JOIN public.clearance_sessions cs ON cs.id=ss.session_id
      LEFT JOIN public.departments d ON d.id=sr.department_id
      LEFT JOIN public.programmes p ON p.id=sr.programme_id
      WHERE ss.final_assent='assented'::public.final_assent_status
        AND ss.completed_at IS NOT NULL;
    END IF;

    SELECT COALESCE(NULLIF(setting_value #>> '{}','')::integer,24)
    INTO v_interval_hours
    FROM public.app_settings WHERE setting_key='officer_reminder_interval_hours';
    RETURN jsonb_build_object(
      'can_configure_reminders', EXISTS (SELECT 1 FROM public.staff_role_assignments ra WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role='superadmin'),
      'reminder_interval_hours', COALESCE(v_interval_hours,24),
      'requests', v_requests,
      'assent_queue', v_assent_queue,
      'completed_queue', v_completed_queue
    );
  ELSIF p_action IN ('clear', 'comment') THEN
    IF EXISTS (SELECT 1 FROM public.staff_role_assignments ra
               WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role='superadmin') THEN
      RAISE EXCEPTION 'SuperAdmin accounts cannot process clearance requests' USING ERRCODE = '42501';
    END IF;
    v_request_id := NULLIF(p_payload->>'request_id','')::uuid;
    IF v_request_id IS NULL THEN RAISE EXCEPTION 'Clearance request is required'; END IF;

    SELECT req.office_id, cr.session_student_id, cr.status
    INTO v_office_id, v_session_student_id, v_status
    FROM public.clearance_requests cr
    JOIN public.clearance_requirements req ON req.id=cr.requirement_id
    WHERE cr.id=v_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Clearance request not found'; END IF;

    IF NOT (
      EXISTS (SELECT 1 FROM public.staff_role_assignments ra
              WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role = 'admin')
      OR EXISTS (SELECT 1
                 FROM public.staff_role_assignments ra
                 JOIN public.clearance_offices office_scope ON office_scope.id=v_office_id
                 JOIN public.session_students ss_scope ON ss_scope.id=v_session_student_id
                 JOIN public.student_records sr_scope ON sr_scope.id=ss_scope.student_id
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND (
                     (ra.role='clearance_officer' AND ra.office_id=v_office_id AND office_scope.code<>'HOD')
                     OR (ra.role='head_of_department' AND ra.office_id=v_office_id AND office_scope.code='HOD' AND ra.department_id=sr_scope.department_id)
                     OR (ra.role='bursar' AND office_scope.code='BURSARY')
                     OR (ra.role='registrar' AND office_scope.code='REG')
                   ))
    ) THEN
      RAISE EXCEPTION 'You are not assigned to this clearance office' USING ERRCODE = '42501';
    END IF;

    SELECT ra.role INTO v_role
    FROM public.staff_role_assignments ra
    WHERE ra.user_id=p_actor_user_id AND ra.active=true
      AND (ra.office_id=v_office_id OR ra.office_id IS NULL)
    ORDER BY CASE ra.role WHEN 'clearance_officer' THEN 1 WHEN 'admin' THEN 2 ELSE 5 END
    LIMIT 1;
    IF v_role IS NULL THEN RAISE EXCEPTION 'No active role found'; END IF;

    IF p_action = 'clear' THEN
      IF v_status NOT IN ('requested'::public.clearance_status, 'needs_attention'::public.clearance_status) THEN
        RAISE EXCEPTION 'Only requested or needs-attention items can be cleared';
      END IF;
      UPDATE public.clearance_requests
      SET status='cleared'::public.clearance_status, decision_at=now(),
          decided_by=p_actor_user_id, updated_at=now()
      WHERE id=v_request_id;
      INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
      VALUES(p_actor_user_id,'clearance.request_cleared','clearance_request',v_request_id::text,
        jsonb_build_object('office_id',v_office_id,'session_student_id',v_session_student_id));
      INSERT INTO public.notifications(recipient_student_id,clearance_request_id,channel,notification_type,title,message,delivery_status)
      SELECT ss.student_id,v_request_id,'in_app','clearance_cleared','Clearance approved',
        'Your clearance request has been cleared by '||co.name||'.','queued'
      FROM public.session_students ss CROSS JOIN public.clearance_offices co
      WHERE ss.id=v_session_student_id AND co.id=v_office_id;
      RETURN jsonb_build_object('success',true,'request_id',v_request_id,'status','cleared');
    ELSE
      v_comment := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'comment_text','')),'');
      IF v_comment IS NULL OR length(v_comment)>3000 THEN
        RAISE EXCEPTION 'Enter a remark of 1 to 3000 characters';
      END IF;
      IF v_status='not_requested'::public.clearance_status THEN
        RAISE EXCEPTION 'A remark cannot be added before the student requests clearance';
      END IF;
      INSERT INTO public.clearance_comments(clearance_request_id,author_user_id,author_role,comment_text,visible_to_student)
      VALUES(v_request_id,p_actor_user_id,v_role::text,v_comment,true);
      INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
      VALUES(p_actor_user_id,'clearance.remark_added','clearance_request',v_request_id::text,
        jsonb_build_object('office_id',v_office_id,'session_student_id',v_session_student_id,'comment_length',length(v_comment)));
      RETURN jsonb_build_object('success',true,'request_id',v_request_id,'comment_added',true);
    END IF;
  ELSIF p_action = 'final_assent' THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                   WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role='provost') THEN
      RAISE EXCEPTION 'Provost role required for Final Assent' USING ERRCODE = '42501';
    END IF;
    v_session_student_id := NULLIF(p_payload->>'session_student_id','')::uuid;
    v_assent := NULLIF(p_payload->>'status','')::public.final_assent_status;
    v_remarks := NULLIF(pg_catalog.btrim(COALESCE(p_payload->>'remarks','')),'');
    IF v_session_student_id IS NULL OR v_assent IS NULL OR v_assent NOT IN ('assented'::public.final_assent_status,'declined'::public.final_assent_status,'revoked'::public.final_assent_status) THEN
      RAISE EXCEPTION 'Choose a valid student and Final Assent decision';
    END IF;
    IF v_assent='assented'::public.final_assent_status AND NOT EXISTS (
      SELECT 1
      FROM public.session_students ss
      JOIN public.student_records sr ON sr.id=ss.student_id
      JOIN public.clearance_requirements req ON req.session_id=ss.session_id
      WHERE ss.id=v_session_student_id AND req.enabled=true AND req.required=true
        AND (req.department_id IS NULL OR req.department_id=sr.department_id)
        AND (req.programme_id IS NULL OR req.programme_id=sr.programme_id)
    ) THEN
      RAISE EXCEPTION 'No enabled required clearance requirements are configured for this student session';
    END IF;
    IF v_assent='assented'::public.final_assent_status AND EXISTS (
      SELECT 1
      FROM public.session_students ss
      JOIN public.student_records sr ON sr.id=ss.student_id
      JOIN public.clearance_requirements req ON req.session_id=ss.session_id
      LEFT JOIN public.clearance_requests cr ON cr.requirement_id=req.id AND cr.session_student_id=ss.id
      WHERE ss.id=v_session_student_id AND req.enabled=true AND req.required=true
        AND (req.department_id IS NULL OR req.department_id=sr.department_id)
        AND (req.programme_id IS NULL OR req.programme_id=sr.programme_id)
        AND cr.status IS DISTINCT FROM 'cleared'::public.clearance_status
    ) THEN
      RAISE EXCEPTION 'Final Assent is blocked until every required clearance is cleared';
    END IF;
    UPDATE public.session_students
    SET final_assent=v_assent, final_assent_at=now(), final_assent_by=p_actor_user_id,
        final_assent_remarks=v_remarks,
        completed_at=CASE WHEN v_assent='assented'::public.final_assent_status THEN now() ELSE NULL END,
        updated_at=now()
    WHERE id=v_session_student_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Student session record not found'; END IF;
    INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
    VALUES(p_actor_user_id,'provost.final_assent_'||v_assent::text,'session_student',v_session_student_id::text,
      jsonb_build_object('status',v_assent::text,'remarks',v_remarks));
    INSERT INTO public.notifications(recipient_student_id,channel,notification_type,title,message,delivery_status)
    SELECT ss.student_id,'in_app','final_assent_'||v_assent::text,
      CASE WHEN v_assent='assented'::public.final_assent_status THEN 'Final Assent granted' ELSE 'Final Assent updated' END,
      CASE WHEN v_assent='assented'::public.final_assent_status THEN 'The Provost has granted Final Assent. Your clearance is complete.'
           WHEN v_assent='declined'::public.final_assent_status THEN 'The Provost has declined Final Assent. Check your clearance portal for details.'
           ELSE 'Your Final Assent status has been revoked. Contact the college for guidance.' END,
      'queued'
    FROM public.session_students ss WHERE ss.id=v_session_student_id;
    RETURN jsonb_build_object('success',true,'session_student_id',v_session_student_id,'final_assent',v_assent::text);
  ELSE
    RAISE EXCEPTION 'Unsupported clearance workflow action';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.can_access_clearance_request(target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      join public.clearance_offices co on co.id = req.office_id
      join public.session_students ss on ss.id = cr.session_student_id
      join public.student_records sr on sr.id = ss.student_id
      join public.staff_role_assignments sra
        on sra.user_id = auth.uid()
       and sra.active = true
       and (
         (sra.role = 'clearance_officer'::public.app_role and sra.office_id = req.office_id and co.code <> 'HOD')
         or (sra.role = 'head_of_department'::public.app_role and sra.office_id = req.office_id and co.code = 'HOD' and sra.department_id = sr.department_id)
         or (sra.role = 'bursar'::public.app_role and co.code = 'BURSARY')
         or (sra.role = 'registrar'::public.app_role and co.code = 'REG')
       )
      where cr.id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
        
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_session_student(target_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      join public.clearance_offices co on co.id = req.office_id
      join public.session_students ss_scope on ss_scope.id = cr.session_student_id
      join public.student_records sr on sr.id = ss_scope.student_id
      join public.staff_role_assignments sra
        on sra.user_id = auth.uid()
       and sra.active = true
       and (
         (sra.role = 'clearance_officer'::public.app_role and sra.office_id = req.office_id and co.code <> 'HOD')
         or (sra.role = 'head_of_department'::public.app_role and sra.office_id = req.office_id and co.code = 'HOD' and sra.department_id = sr.department_id)
         or (sra.role = 'bursar'::public.app_role and co.code = 'BURSARY')
         or (sra.role = 'registrar'::public.app_role and co.code = 'REG')
       )
      where cr.session_student_id = target_id
        and cr.status <> 'not_requested'::public.clearance_status
        
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_student_record(target_student_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      join public.clearance_offices co on co.id = req.office_id
      join public.student_records sr_scope on sr_scope.id = ss.student_id
      join public.staff_role_assignments sra
        on sra.user_id = auth.uid()
       and sra.active = true
       and (
         (sra.role = 'clearance_officer'::public.app_role and sra.office_id = req.office_id and co.code <> 'HOD')
         or (sra.role = 'head_of_department'::public.app_role and sra.office_id = req.office_id and co.code = 'HOD' and sra.department_id = sr_scope.department_id)
         or (sra.role = 'bursar'::public.app_role and co.code = 'BURSARY')
         or (sra.role = 'registrar'::public.app_role and co.code = 'REG')
       )
      where ss.student_id = target_student_id
        and cr.status <> 'not_requested'::public.clearance_status
        
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.notify_clearance_request_submitted()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
    WHERE ra.active=true AND (
      (ra.role='clearance_officer'::public.app_role AND ra.office_id=v_office_id AND v_office_code<>'HOD')
      OR (ra.role='head_of_department'::public.app_role AND ra.office_id=v_office_id AND v_office_code='HOD' AND ra.department_id=v_department_id)
      OR (ra.role='bursar'::public.app_role AND v_office_code='BURSARY')
      OR (ra.role='registrar'::public.app_role AND v_office_code='REG')
    );
    INSERT INTO public.audit_events(actor_student_id,event_type,entity_type,entity_id,details)
    VALUES(v_student_id,'clearance.requested','clearance_request',NEW.id::text,
      jsonb_build_object('office_id',v_office_id,'requirement_id',NEW.requirement_id,'session_student_id',NEW.session_student_id));
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_clearance_reminders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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
    WHERE ra.active=true AND (
      (ra.role='clearance_officer'::public.app_role AND ra.office_id=v_office_id AND v_office_code<>'HOD')
      OR (ra.role='head_of_department'::public.app_role AND ra.office_id=v_office_id AND v_office_code='HOD' AND ra.department_id=v_department_id)
      OR (ra.role='bursar'::public.app_role AND v_office_code='BURSARY')
      OR (ra.role='registrar'::public.app_role AND v_office_code='REG')
    );
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
$function$

COMMIT;
