import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...headers, "Content-Type": "application/json" },
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

    const client = createClient(url, anon, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData.user) return json({ error: "Invalid session" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");
    const allowed = new Set(["list_queue", "clear", "comment", "final_assent", "set_reminder_interval"]);
    if (!allowed.has(action)) return json({ error: "Unsupported clearance action" }, 400);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.rpc("manage_clearance_workflow", {
      p_actor_user_id: userData.user.id,
      p_action: action,
      p_payload: payload,
    });
    if (error) {
      console.error("manage-clearance RPC failed", { actor: userData.user.id, action, code: error.code, message: error.message });
      if (error.code === "42501") return json({ error: error.message || "You are not authorised to perform this action." }, 403);
      if (error.code === "23505") return json({ error: "This record already exists." }, 409);
      return json({ error: error.message || "Clearance operation failed." }, 400);
    }
    if (action === "list_queue" && data && typeof data === "object" && !Array.isArray(data)) {
      const { data: assignments, error: assignmentError } = await admin
        .from("staff_role_assignments")
        .select("role, office_id")
        .eq("user_id", userData.user.id)
        .eq("active", true);
      if (assignmentError) {
        console.error("manage-clearance role lookup failed", { actor: userData.user.id, message: assignmentError.message });
        return json({ error: "Could not verify clearance office assignments" }, 500);
      }

      const roles = assignments ?? [];
      const hasPlatformWideQueueAccess = roles.some((item) => ["superadmin", "admin"].includes(item.role));
      if (!hasPlatformWideQueueAccess) {
        const assignedOfficeIds = new Set(
          roles
            .filter((item) => ["clearance_officer", "unit_head"].includes(item.role) && item.office_id)
            .map((item) => item.office_id as string),
        );
        const result = data as Record<string, unknown>;
        const requests = Array.isArray(result.requests) ? result.requests : [];
        return json({
          ...result,
          requests: requests.filter((item) =>
            item && typeof item === "object" &&
            assignedOfficeIds.has(String((item as Record<string, unknown>).office_id ?? "")),
          ),
        });
      }
    }

    return json(data ?? { success: true });
  } catch (error) {
    console.error("manage-clearance unexpected error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});

