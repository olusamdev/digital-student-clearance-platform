import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500);
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return json({ error: "Invalid session" }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" && body.payload !== null ? body.payload : {};
    if (!["list", "save", "toggle"].includes(action)) return json({ error: "Unsupported requirements action" }, 400);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: result, error: rpcError } = await admin.rpc("manage_clearance_requirements", {
      p_actor_user_id: data.user.id, p_action: action, p_payload: payload,
    });
    if (rpcError) {
      console.error("manage-clearance-requirements RPC failed", { actor: data.user.id, action, code: rpcError.code, message: rpcError.message });
      if (rpcError.code === "42501") return json({ error: "SuperAdmin access required" }, 403);
      if (rpcError.code === "23505") return json({ error: "A requirement already exists for this session, office and scope." }, 409);
      return json({ error: rpcError.message || "Clearance requirements change failed" }, 400);
    }
    return json(result ?? { success: true });
  } catch (error) {
    console.error("manage-clearance-requirements unexpected error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
