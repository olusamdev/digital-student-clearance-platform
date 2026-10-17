import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// This endpoint is intended for a scheduler. Deploy with JWT verification disabled,
// then protect it with a strong CRON_SECRET sent as the x-cron-secret header.
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const expected = Deno.env.get("CRON_SECRET") ?? "";
  const supplied = req.headers.get("x-cron-secret") ?? "";
  if (!expected || supplied.length < 32 || supplied !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !service) return new Response("Server configuration incomplete", { status: 500 });

  try {
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.rpc("process_clearance_reminders");
    if (error) {
      console.error("process-clearance-reminders RPC failed", { code: error.code, message: error.message });
      return new Response(JSON.stringify({ error: "Reminder processing failed" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(data ?? { success: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("process-clearance-reminders unexpected error", error);
    return new Response(JSON.stringify({ error: "Unexpected server error" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});

