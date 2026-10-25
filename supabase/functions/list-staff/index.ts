import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

type AuthDirectoryEntry = {
  invited_at: string | null;
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  banned_until: string | null;
};

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500);
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await client.auth.getUser();
    const actor = userData.user;
    if (userError || !actor) return json({ error: "Invalid session" }, 401);
    const { data: profile, error: profileError } = await admin.from("staff_profiles").select("user_id").eq("user_id", actor.id).eq("active", true).maybeSingle();
    const { data: roles, error: rolesError } = await admin.from("staff_role_assignments").select("role").eq("user_id", actor.id).eq("active", true);
    if (profileError || rolesError) {
      console.error("list-staff permission query failed", {
        profileError: profileError?.message,
        rolesError: rolesError?.message
      });
      return json({ error: "Could not verify staff permissions" }, 500);
    }
    if (!profile || !roles?.some((role) => role.role === "superadmin")) return json({ error: "SuperAdmin access required" }, 403);

    const [profilesResult, assignmentsResult, officesResult] = await Promise.all([
      admin.from("staff_profiles").select("user_id, full_name, username, email, staff_number, must_change_password, active, created_at").order("full_name", { ascending: true }),
      admin.from("staff_role_assignments").select("user_id, role, office_id, department_id, active"),
      admin.from("clearance_offices").select("id, code, name, active").order("display_order", { ascending: true }),
      admin.from("departments").select("id, code, name, active").order("name", { ascending: true }),
    ]);
    const departmentsResult = await admin.from("departments").select("id, code, name, active").order("name", { ascending: true });
    if (profilesResult.error || assignmentsResult.error || officesResult.error || departmentsResult.error) {
      console.error("list-staff query failed", { profiles: profilesResult.error?.message, assignments: assignmentsResult.error?.message, offices: officesResult.error?.message, departments: departmentsResult.error?.message });
      return json({ error: "Could not load staff directory" }, 500);
    }

    const authDirectory = new Map<string, AuthDirectoryEntry>();
    let page = 1;
    for (;;) {
      const { data: authData, error: authError } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (authError) {
        console.error("list-staff auth query failed", { page, message: authError.message });
        return json({ error: "Could not load staff invitation status" }, 500);
      }
      for (const authUser of authData?.users ?? []) {
        authDirectory.set(authUser.id, {
          invited_at: authUser.invited_at ?? null,
          email_confirmed_at: authUser.email_confirmed_at ?? null,
          confirmed_at: authUser.confirmed_at ?? null,
          banned_until: authUser.banned_until ?? null,
        });
      }
      const nextPage = authData?.nextPage ?? null;
      if (!nextPage || nextPage === page) break;
      page = nextPage;
    }

    const officeMap = new Map((officesResult.data ?? []).map((office) => [office.id, office.name]));
    const departmentMap = new Map((departmentsResult.data ?? []).map((department) => [department.id, department.name]));
    const rolesByUser = new Map<string, unknown[]>();
    for (const assignment of assignmentsResult.data ?? []) {
      const list = rolesByUser.get(assignment.user_id) ?? [];
      list.push({ role: assignment.role, office_id: assignment.office_id, department_id: assignment.department_id ?? null, active: assignment.active, office_name: assignment.office_id ? officeMap.get(assignment.office_id) ?? null : null, department_name: assignment.department_id ? departmentMap.get(assignment.department_id) ?? null : null });
      rolesByUser.set(assignment.user_id, list);
    }

    const now = Date.now();
    const staff = (profilesResult.data ?? []).map((item) => {
      const auth = authDirectory.get(item.user_id);
      const emailConfirmedAt = auth?.email_confirmed_at ?? auth?.confirmed_at ?? null;
      const bannedUntil = auth?.banned_until ? Date.parse(auth.banned_until) : Number.NaN;
      const isBanned = Number.isFinite(bannedUntil) && bannedUntil > now;
      const status = !item.active || isBanned ? "inactive" : !auth ? "missing" : emailConfirmedAt ? "active" : "invited";
      return {
        ...item,
        status,
        invited_at: auth?.invited_at ?? null,
        email_confirmed_at: emailConfirmedAt,
        roles: rolesByUser.get(item.user_id) ?? [],
      };
    });

    return json({ staff, offices: officesResult.data ?? [], departments: departmentsResult.data ?? [] });
  } catch (error) {
    console.error("list-staff unexpected error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
