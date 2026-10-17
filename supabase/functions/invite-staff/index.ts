import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "";
const cors = (origin: string) => ({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" });
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!allowedOrigin || origin !== allowedOrigin) return new Response("Forbidden", { status: 403 });
  const headers = cors(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500);
    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: ud, error: ue } = await client.auth.getUser(), actor = ud.user;
    if (ue || !actor) return json({ error: "Invalid session" }, 401);
    const { data: profile, error: pe } = await admin.from("staff_profiles").select("user_id").eq("user_id", actor.id).eq("active", true).maybeSingle();
    const { data: roles, error: re } = await admin.from("staff_role_assignments").select("role").eq("user_id", actor.id).eq("active", true);
    if (pe || re) return json({ error: "Could not verify staff permissions" }, 500);
    if (!profile || !roles?.some((r) => r.role === "superadmin")) return json({ error: "SuperAdmin access required" }, 403);
    const body = await req.json();
    const email = String(body.email ?? "").trim().toLowerCase(), name = String(body.full_name ?? "").trim();
    const staffNumber = body.staff_number == null ? null : String(body.staff_number).trim();
    const role = String(body.role ?? ""), officeId = body.office_id ? String(body.office_id) : null;
    const redirectTo = Deno.env.get("STAFF_INVITE_REDIRECT_URL") ?? "";
    const rolesAllowed = ["admin", "clearance_officer", "unit_head", "registrar", "provost", "certification_officer"];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length > 160 || (staffNumber && staffNumber.length > 80) || !rolesAllowed.includes(role))
      return json({ error: "Provide a valid email, full name, and permitted role" }, 400);
    if (["clearance_officer", "unit_head"].includes(role) !== Boolean(officeId)) return json({ error: "Office assignment is required only for office-scoped roles" }, 400);
    if (!redirectTo) return json({ error: "Configure STAFF_INVITE_REDIRECT_URL before inviting staff" }, 500);
    const { data: invite, error: ie } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo, data: { full_name: name } });
    if (ie || !invite.user) return json({ error: ie?.message ?? "Invitation failed" }, 400);
    const { error: rpcError } = await admin.rpc("provision_staff_assignment", {
      p_actor_user_id: actor.id, p_target_user_id: invite.user.id, p_full_name: name, p_email: email,
      p_staff_number: staffNumber, p_role: role, p_office_id: officeId,
    });
    if (rpcError) {
      const { error: rollback } = await admin.auth.admin.deleteUser(invite.user.id);
      if (rollback) console.error("Invite rollback failed", { id: invite.user.id, message: rollback.message });
      console.error("Provisioning failed", { id: invite.user.id, message: rpcError.message });
      return json({ error: "Staff invitation could not be completed; verify account status before retrying" }, 500);
    }
    return json({ success: true, invited_email: email, role });
  } catch (e) { console.error("invite-staff error", e); return json({ error: "Unexpected server error" }, 500); }
});
