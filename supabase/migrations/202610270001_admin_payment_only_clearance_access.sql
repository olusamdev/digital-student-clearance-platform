DO $migration$
DECLARE
  v_definition text;
  v_original text;
BEGIN
  SELECT pg_get_functiondef('public.manage_clearance_workflow(uuid,text,jsonb)'::regprocedure)
    INTO v_definition;
  v_original := v_definition;

  v_definition := replace(
    v_definition,
    'ra.role IN (''superadmin'',''admin'',''clearance_officer'',''head_of_department'',''bursar'',''provost'',''registrar'')',
    'ra.role IN (''superadmin'',''clearance_officer'',''head_of_department'',''bursar'',''provost'',''registrar'')'
  );

  v_definition := replace(
    v_definition,
    'EXISTS (SELECT 1 FROM public.staff_role_assignments ra
                  WHERE ra.user_id = p_actor_user_id AND ra.active = true
                    AND ra.role = ''admin'')',
    'false'
  );

  v_definition := replace(
    v_definition,
    'ra.role IN (''registrar'',''superadmin'',''admin'')',
    'ra.role IN (''registrar'',''superadmin'')'
  );

  v_definition := replace(
    v_definition,
    'EXISTS (SELECT 1 FROM public.staff_role_assignments ra
              WHERE ra.user_id=p_actor_user_id AND ra.active=true AND ra.role = ''admin'')',
    'false'
  );

  v_definition := replace(
    v_definition,
    'ORDER BY CASE ra.role WHEN ''clearance_officer'' THEN 1 WHEN ''admin'' THEN 2 ELSE 5 END',
    'ORDER BY CASE ra.role WHEN ''clearance_officer'' THEN 1 ELSE 5 END'
  );

  IF v_definition = v_original THEN
    RAISE EXCEPTION 'Admin restriction migration made no changes; function definition did not match expected patterns';
  END IF;

  IF position('ra.role IN (''superadmin'',''admin'',''clearance_officer''' in v_definition) > 0
     OR position('ra.role IN (''registrar'',''superadmin'',''admin'')' in v_definition) > 0
     OR position('ra.role = ''admin'')' in v_definition) > 0 THEN
    RAISE EXCEPTION 'Admin clearance permissions remain after attempted migration; aborting';
  END IF;

  EXECUTE v_definition;
END
$migration$;