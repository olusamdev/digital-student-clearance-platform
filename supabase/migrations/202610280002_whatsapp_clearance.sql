BEGIN;

ALTER TABLE public.staff_profiles
  ADD COLUMN IF NOT EXISTS whatsapp_phone text,
  ADD COLUMN IF NOT EXISTS whatsapp_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.staff_profiles
  DROP CONSTRAINT IF EXISTS staff_profiles_whatsapp_phone_format;
ALTER TABLE public.staff_profiles
  ADD CONSTRAINT staff_profiles_whatsapp_phone_format
  CHECK (whatsapp_phone IS NULL OR whatsapp_phone ~ '^[1-9][0-9]{7,14}$');

CREATE UNIQUE INDEX IF NOT EXISTS staff_profiles_unique_enabled_whatsapp_phone
  ON public.staff_profiles (whatsapp_phone)
  WHERE whatsapp_enabled = true AND whatsapp_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clearance_request_id uuid REFERENCES public.clearance_requests(id) ON DELETE SET NULL,
  recipient_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  event_type text NOT NULL,
  phone_number text NOT NULL,
  provider_message_id text UNIQUE,
  delivery_status text NOT NULL DEFAULT 'queued',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_one_request_notice_per_officer
  ON public.whatsapp_messages (clearance_request_id, recipient_user_id, event_type)
  WHERE direction = 'outbound' AND clearance_request_id IS NOT NULL;

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_messages TO service_role;

CREATE TABLE IF NOT EXISTS public.whatsapp_pending_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  clearance_request_id uuid NOT NULL REFERENCES public.clearance_requests(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_pending_comment_one_open_per_officer
  ON public.whatsapp_pending_comments(recipient_user_id)
  WHERE consumed_at IS NULL;
ALTER TABLE public.whatsapp_pending_comments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_pending_comments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.whatsapp_pending_comments TO service_role;

CREATE OR REPLACE FUNCTION public.process_whatsapp_clearance_action(
  p_phone text,
  p_request_id uuid,
  p_action text,
  p_comment_text text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_phone text := regexp_replace(COALESCE(p_phone, ''), '[^0-9]', '', 'g');
  v_actor uuid;
  v_role public.app_role;
  v_request public.clearance_requests%ROWTYPE;
  v_office_id uuid;
  v_office_code text;
  v_office_name text;
  v_student_id uuid;
  v_student_name text;
  v_registration_number text;
  v_department_id uuid;
  v_comment text := NULLIF(pg_catalog.btrim(COALESCE(p_comment_text, '')), '');
BEGIN
  IF p_action NOT IN ('clear','comment') THEN
    RAISE EXCEPTION 'Unsupported WhatsApp action';
  END IF;

  SELECT sp.user_id INTO v_actor
  FROM public.staff_profiles sp
  WHERE sp.active = true
    AND sp.whatsapp_enabled = true
    AND sp.whatsapp_phone = v_phone;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'This WhatsApp number is not enabled for an active DSCP officer' USING ERRCODE = '42501';
  END IF;

  SELECT cr.* INTO v_request
  FROM public.clearance_requests cr
  WHERE cr.id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Clearance request not found'; END IF;
  IF v_request.status NOT IN ('requested'::public.clearance_status, 'needs_attention'::public.clearance_status) THEN
    RAISE EXCEPTION 'This request is no longer awaiting an officer decision';
  END IF;

  SELECT req.office_id, co.code, co.name, ss.student_id, sr.full_name,
         sr.registration_number, sr.department_id
  INTO v_office_id, v_office_code, v_office_name, v_student_id, v_student_name,
       v_registration_number, v_department_id
  FROM public.clearance_requirements req
  JOIN public.clearance_offices co ON co.id = req.office_id
  JOIN public.session_students ss ON ss.id = v_request.session_student_id
  JOIN public.student_records sr ON sr.id = ss.student_id
  WHERE req.id = v_request.requirement_id;

  SELECT ra.role INTO v_role
  FROM public.staff_role_assignments ra
  WHERE ra.user_id = v_actor AND ra.active = true
    AND (
      (ra.role = 'clearance_officer'::public.app_role AND ra.office_id = v_office_id AND v_office_code <> 'HOD')
      OR (ra.role = 'head_of_department'::public.app_role AND ra.office_id = v_office_id
          AND v_office_code = 'HOD' AND ra.department_id = v_department_id)
      OR (ra.role = 'bursar'::public.app_role AND v_office_code = 'BURSARY')
      OR (ra.role = 'registrar'::public.app_role AND v_office_code = 'REG')
    )
  ORDER BY ra.created_at
  LIMIT 1;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'This officer is not assigned to the request office or department' USING ERRCODE = '42501';
  END IF;

  IF p_action = 'clear' THEN
    UPDATE public.clearance_requests
    SET status = 'cleared'::public.clearance_status,
        decision_at = now(), decided_by = v_actor, updated_at = now()
    WHERE id = p_request_id
      AND status IN ('requested'::public.clearance_status, 'needs_attention'::public.clearance_status);
    IF NOT FOUND THEN RAISE EXCEPTION 'This request was already processed'; END IF;

    INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
    VALUES(v_actor,'clearance.request_cleared_via_whatsapp','clearance_request',p_request_id::text,
      jsonb_build_object('office_id',v_office_id,'session_student_id',v_request.session_student_id,'channel','whatsapp'));
    INSERT INTO public.notifications(recipient_student_id,clearance_request_id,channel,notification_type,title,message,delivery_status)
    VALUES(v_student_id,p_request_id,'in_app','clearance_cleared','Clearance approved',
      'Your clearance request has been cleared by ' || v_office_name || '.', 'queued');
  ELSE
    IF v_comment IS NULL OR length(v_comment) > 3000 THEN
      RAISE EXCEPTION 'Enter a comment of 1 to 3000 characters';
    END IF;
    INSERT INTO public.clearance_comments(clearance_request_id,author_user_id,author_role,comment_text,visible_to_student)
    VALUES(p_request_id,v_actor,v_role::text,v_comment,true);
    INSERT INTO public.audit_events(actor_user_id,event_type,entity_type,entity_id,details)
    VALUES(v_actor,'clearance.remark_added_via_whatsapp','clearance_request',p_request_id::text,
      jsonb_build_object('office_id',v_office_id,'session_student_id',v_request.session_student_id,
                         'comment_length',length(v_comment),'channel','whatsapp'));
  END IF;

  RETURN jsonb_build_object(
    'success',true,'action',p_action,'request_id',p_request_id,'status',
    CASE WHEN p_action='clear' THEN 'cleared' ELSE v_request.status::text END,
    'actor_user_id',v_actor,'session_student_id',v_request.session_student_id,
    'student_name',v_student_name,'registration_number',v_registration_number,
    'office_name',v_office_name,'office_code',v_office_code
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_whatsapp_clearance_action(text,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_whatsapp_clearance_action(text,uuid,text,text) TO service_role;

COMMIT;
