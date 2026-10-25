-- SuperAdmins administer the platform but must not receive or act on student clearance requests.
-- Preserve office-scoped officer/HOD routing, Registrar completed-register access, Provost assent, and SuperAdmin settings.
CREATE OR REPLACE FUNCTION public.manage_clearance_workflow(
  p_actor_user_id uuid,
  p_action text,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
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
        AND ra.role IN ('superadmin','admin','clearance_officer','unit_head','head_of_department','provost','registrar')
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
                       AND ra.role IN ('clearance_officer','unit_head')
                       AND ra.office_id = req.office_id)
          OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                     WHERE ra.user_id = p_actor_user_id AND ra.active = true
                       AND ra.role = 'head_of_department'
                       AND ra.office_id = req.office_id
                       AND ra.department_id = sr.department_id)
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
                 JOIN public.session_students ss_scope ON ss_scope.id=v_session_student_id
                 JOIN public.student_records sr_scope ON sr_scope.id=ss_scope.student_id
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND ra.role='head_of_department'
                   AND ra.office_id=v_office_id
                   AND ra.department_id=sr_scope.department_id)
      OR EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                 WHERE ra.user_id=p_actor_user_id AND ra.active=true
                   AND ra.role IN ('clearance_officer','unit_head') AND ra.office_id=v_office_id)
    ) THEN
      RAISE EXCEPTION 'You are not assigned to this clearance office' USING ERRCODE = '42501';
    END IF;

    SELECT ra.role INTO v_role
    FROM public.staff_role_assignments ra
    WHERE ra.user_id=p_actor_user_id AND ra.active=true
      AND (ra.office_id=v_office_id OR ra.office_id IS NULL)
    ORDER BY CASE ra.role WHEN 'head_of_department' THEN 1 WHEN 'unit_head' THEN 2 WHEN 'clearance_officer' THEN 3 WHEN 'admin' THEN 4 ELSE 5 END
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
