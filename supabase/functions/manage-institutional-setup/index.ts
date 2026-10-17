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
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return json({ error: "Invalid session" }, 401);
    const body = await req.json();
    const actions = new Set(["department_save","department_toggle","programme_save","programme_toggle","office_save","office_toggle","session_save","session_activate","session_deactivate"]);
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    if (!actions.has(action)) return json({ error: "Unsupported setup action" }, 400);
    const { data: result, error: rpcError } = await admin.rpc("manage_institutional_setup", { p_actor_user_id: data.user.id, p_action: action, p_payload: payload });
    if (rpcError) {
      console.error("manage-institutional-setup RPC failed", { actor: data.user.id, action, message: rpcError.message, code: rpcError.code });
      if (rpcError.code === "42501") return json({ error: "SuperAdmin access required" }, 403);
      if (rpcError.code === "23505") return json({ error: "That code or name already exists. Check existing records." }, 409);
      if (rpcError.code === "23503") return json({ error: "This record is linked to existing data and cannot be changed that way." }, 409);
      return json({ error: rpcError.message || "Institutional setup change failed" }, 400);
    }
    return json(result ?? { success: true });
  } catch (error) { console.error("manage-institutional-setup unexpected error", error); return json({ error: "Unexpected server error" }, 500); }
});
