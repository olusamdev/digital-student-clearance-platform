import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";
Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin), json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
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
    const body = await req.json(), targetId = String(body.target_user_id ?? ""), reason = body.reason == null ? null : String(body.reason).trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) return json({ error: "Valid target user ID required" }, 400);
    if (targetId === actor.id) return json({ error: "You cannot deactivate your own account" }, 400);
    if (reason && reason.length > 500) return json({ error: "Reason must be 500 characters or fewer" }, 400);
    const { data: target, error: te } = await admin.auth.admin.getUserById(targetId);
    if (te || !target.user) return json({ error: "Target auth account not found" }, 404);
    const oldBan = target.user.banned_until;
    const { error: be } = await admin.auth.admin.updateUserById(targetId, { ban_duration: "876000h" });
    if (be) return json({ error: "Could not suspend target sign-in" }, 500);
    const { error: rpcError } = await admin.rpc("deactivate_staff_account", { p_actor_user_id: actor.id, p_target_user_id: targetId, p_reason: reason });
    if (rpcError) {
      const restore = oldBan && new Date(oldBan).getTime() > Date.now()
        ? `${Math.max(1, Math.floor((new Date(oldBan).getTime() - Date.now()) / 3600000))}h` : "none";
      const { error: rollback } = await admin.auth.admin.updateUserById(targetId, { ban_duration: restore });
      if (rollback) console.error("Ban rollback failed", { targetId, message: rollback.message });
      console.error("Deactivation failed", { targetId, message: rpcError.message });
      return json({ error: "Deactivation failed; verify the account status before retrying" }, 500);
    }
    return json({ success: true });
  } catch (e) { console.error("deactivate-staff error", e); return json({ error: "Unexpected server error" }, 500); }
});
