import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function activationCode() {
  let code = "";
  const bytes = new Uint8Array(16);
  while (code.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 256 - (256 % alphabet.length)) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length === 6) break;
    }
  }
  return code;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" } });
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
    if (profileError || rolesError) return json({ error: "Could not verify staff permissions" }, 500);
    if (!profile || !roles?.some((r) => r.role === "superadmin")) return json({ error: "SuperAdmin access required" }, 403);

    const body = await req.json();
    const username = String(body.username ?? "").trim().toLowerCase();
    const name = String(body.full_name ?? "").trim();
    const staffNumber = body.staff_number == null ? null : String(body.staff_number).trim() || null;
    const role = String(body.role ?? "");
    const officeId = body.office_id ? String(body.office_id) : null;
    const departmentId = body.department_id ? String(body.department_id) : null;
    const rolesAllowed = ["admin", "clearance_officer", "head_of_department", "registrar", "provost", "certification_officer", "bursar"];
    if (!/^[a-z0-9._-]{3,40}$/.test(username) || !name || name.length > 160 || (staffNumber && staffNumber.length > 80) || !rolesAllowed.includes(role)) {
      return json({ error: "Provide a valid username, full name, optional staff number, and permitted role" }, 400);
    }
    const officeScoped = role === "clearance_officer" || role === "head_of_department";
    if (officeScoped !== Boolean(officeId)) return json({ error: "Clearance Officer and Head of Department accounts require their appropriate clearance office assignment" }, 400);
    const allowedOfficeCodes = role === "head_of_department"
      ? new Set(["HOD"])
      : new Set(["EO", "LB", "LAB", "DU", "DM", "SM", "SAD"]);
    let officeCode: string | null = null;
    if (officeId) {
      const { data: office, error } = await admin.from("clearance_offices").select("id, code").eq("id", officeId).eq("active", true).maybeSingle();
      if (error || !office) return json({ error: "Selected clearance office is missing or inactive" }, 400);
      if (!allowedOfficeCodes.has(office.code)) return json({ error: role === "head_of_department" ? "Head of Department accounts must be assigned the HOD office" : "Choose EO, LB, LAB, DU, DM, SM, or SAD for a Clearance Officer account" }, 400);
      officeCode = office.code;
    }
    const departmentRequired = role === "head_of_department";
    if (departmentRequired !== Boolean(departmentId)) {
      return json({ error: "Select a department for the Head of Department role only" }, 400);
    }
    if (departmentId) {
      const { data: department, error } = await admin.from("departments").select("id").eq("id", departmentId).eq("active", true).maybeSingle();
      if (error || !department) return json({ error: "Selected department is missing or inactive" }, 400);
    }

    const syntheticEmail = username + "@staff.dscp.invalid";
    const code = activationCode();
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: syntheticEmail, password: code, email_confirm: true,
      user_metadata: { full_name: name, staff_username: username, staff_activation_pending: true },
    });
    if (createError || !created.user) {
      return json({ error: createError?.message?.includes("already been registered") ? "That username already exists" : "Could not create the staff login. Check that the username is unused." }, 409);
    }
    const userId = created.user.id;
    const { error: profileInsertError } = await admin.from("staff_profiles").insert({
      user_id: userId, full_name: name, username, staff_number: staffNumber, email: null, active: true, must_change_password: true,
    });
    if (profileInsertError) {
      await admin.auth.admin.deleteUser(userId);
      console.error("Staff profile provisioning failed", { userId, code: profileInsertError.code });
      return json({ error: profileInsertError.code === "23505" ? "Username or staff number already exists" : "Staff account could not be completed" }, 409);
    }
    const { error: assignmentError } = await admin.from("staff_role_assignments").insert({
      user_id: userId, role, office_id: officeId, department_id: departmentId, active: true, created_by: actor.id,
    });
    if (assignmentError) {
      await admin.from("staff_profiles").delete().eq("user_id", userId);
      await admin.auth.admin.deleteUser(userId);
      console.error("Staff role provisioning failed", { userId, code: assignmentError.code });
      return json({ error: "Staff role could not be assigned; no account was retained" }, 500);
    }
    await admin.from("audit_events").insert({
      actor_user_id: actor.id, event_type: "staff.account_created", entity_type: "staff_profile", entity_id: userId,
      details: { username, role, office_id: officeId, department_id: departmentId, staff_number_supplied: Boolean(staffNumber) },
    });
    return json({ success: true, username, activation_code: code, role }, 201);
  } catch (error) {
    console.error("invite-staff error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
