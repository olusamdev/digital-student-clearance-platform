-- Each active Head of Department assignment uniquely owns one department/office queue.
CREATE UNIQUE INDEX IF NOT EXISTS staff_role_assignments_one_active_hod_per_department_office
  ON public.staff_role_assignments (department_id, office_id)
  WHERE role = 'head_of_department'::public.app_role AND active = true;
