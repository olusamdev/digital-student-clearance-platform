BEGIN;
CREATE OR REPLACE FUNCTION public.provision_staff_assignment(
  p_actor_user_id uuid, p_target_user_id uuid, p_full_name text, p_email text,
  p_staff_number text, p_role public.app_role, p_office_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_office_active boolean;
BEGIN
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN RAISE EXCEPTION 'Actor and target user are required'; END IF;
  IF p_actor_user_id = p_target_user_id THEN RAISE EXCEPTION 'Self-provisioning is not permitted'; END IF;
  IF p_role = 'superadmin' THEN RAISE EXCEPTION 'SuperAdmin assignments require a separate controlled process'; END IF;
  IF NULLIF(pg_catalog.btrim(p_full_name), '') IS NULL OR NULLIF(pg_catalog.btrim(p_email), '') IS NULL THEN
    RAISE EXCEPTION 'Full name and email are required';
  END IF;
  IF p_role IN ('clearance_officer', 'unit_head') THEN
    IF p_office_id IS NULL THEN RAISE EXCEPTION 'This role requires an office assignment'; END IF;
    SELECT o.active INTO v_office_active FROM public.clearance_offices o WHERE o.id = p_office_id;
    IF v_office_active IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Office does not exist or is inactive'; END IF;
  ELSIF p_office_id IS NOT NULL THEN RAISE EXCEPTION 'This role must not have an office assignment';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_profiles sp JOIN public.staff_role_assignments sra ON sra.user_id = sp.user_id
    WHERE sp.user_id = p_actor_user_id AND sp.active = TRUE AND sra.role = 'superadmin' AND sra.active = TRUE
  ) THEN RAISE EXCEPTION 'Active SuperAdmin required'; END IF;
  INSERT INTO public.staff_profiles (user_id, full_name, staff_number, email, active)
  VALUES (p_target_user_id, pg_catalog.btrim(p_full_name), NULLIF(pg_catalog.btrim(COALESCE(p_staff_number, '')), ''),
          pg_catalog.lower(pg_catalog.btrim(p_email)), TRUE)
  ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name, staff_number = EXCLUDED.staff_number,
    email = EXCLUDED.email, active = TRUE, updated_at = pg_catalog.now();
  INSERT INTO public.staff_role_assignments (user_id, role, office_id, active, created_by)
  VALUES (p_target_user_id, p_role, p_office_id, TRUE, p_actor_user_id);
  INSERT INTO public.audit_events (actor_user_id, actor_student_id, event_type, entity_type, entity_id, details)
  VALUES (p_actor_user_id, NULL, 'staff.invited_and_assigned', 'staff_profile', p_target_user_id::text,
    pg_catalog.jsonb_build_object('role', p_role::text, 'office_id', p_office_id, 'email', pg_catalog.lower(pg_catalog.btrim(p_email))));
END; $$;

CREATE OR REPLACE FUNCTION public.deactivate_staff_account(
  p_actor_user_id uuid, p_target_user_id uuid, p_reason text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_active_superadmins bigint; v_target_is_active_superadmin boolean;
BEGIN
  IF p_actor_user_id IS NULL OR p_target_user_id IS NULL THEN RAISE EXCEPTION 'Actor and target user are required'; END IF;
  IF p_actor_user_id = p_target_user_id THEN RAISE EXCEPTION 'You cannot deactivate your own account'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(712041, 1);
  IF NOT EXISTS (
    SELECT 1 FROM public.staff_profiles sp JOIN public.staff_role_assignments sra ON sra.user_id = sp.user_id
    WHERE sp.user_id = p_actor_user_id AND sp.active = TRUE AND sra.role = 'superadmin' AND sra.active = TRUE
  ) THEN RAISE EXCEPTION 'Active SuperAdmin required'; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.staff_profiles sp JOIN public.staff_role_assignments sra ON sra.user_id = sp.user_id
    WHERE sp.user_id = p_target_user_id AND sp.active = TRUE AND sra.role = 'superadmin' AND sra.active = TRUE
  ) INTO v_target_is_active_superadmin;
  IF v_target_is_active_superadmin THEN
    SELECT pg_catalog.count(DISTINCT sp.user_id) INTO v_active_superadmins
    FROM public.staff_profiles sp JOIN public.staff_role_assignments sra ON sra.user_id = sp.user_id
    WHERE sp.active = TRUE AND sra.role = 'superadmin' AND sra.active = TRUE;
    IF v_active_superadmins <= 1 THEN RAISE EXCEPTION 'Cannot deactivate the last active SuperAdmin'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_profiles WHERE user_id = p_target_user_id) THEN RAISE EXCEPTION 'Staff profile not found'; END IF;
  UPDATE public.staff_profiles SET active = FALSE, updated_at = pg_catalog.now() WHERE user_id = p_target_user_id;
  UPDATE public.staff_role_assignments SET active = FALSE WHERE user_id = p_target_user_id AND active = TRUE;
  INSERT INTO public.audit_events (actor_user_id, actor_student_id, event_type, entity_type, entity_id, details)
  VALUES (p_actor_user_id, NULL, 'staff.deactivated', 'staff_profile', p_target_user_id::text,
    pg_catalog.jsonb_build_object('reason', NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), ''), 'deactivated_at', pg_catalog.now()));
END; $$;
REVOKE ALL ON FUNCTION public.provision_staff_assignment(uuid, uuid, text, text, text, public.app_role, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.deactivate_staff_account(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_staff_assignment(uuid, uuid, text, text, text, public.app_role, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.deactivate_staff_account(uuid, uuid, text) TO service_role;
COMMIT;
