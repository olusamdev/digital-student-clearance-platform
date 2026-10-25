import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

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
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await client.auth.getUser();
    const user = userData.user;
    if (userError || !user) return json({ error: "Invalid session" }, 401);
    const body = await req.json();
    const password = String(body.new_password ?? "");
    if (password.length < 8 || password.length > 128) return json({ error: "New password must be between 8 and 128 characters" }, 400);
    const { data: profile, error: profileError } = await admin.from("staff_profiles").select("user_id, active, must_change_password").eq("user_id", user.id).maybeSingle();
    if (profileError) return json({ error: "Could not verify staff account" }, 500);
    if (!profile?.active) return json({ error: "Active staff account required" }, 403);
    if (!profile.must_change_password) return json({ error: "First-login password setup is already complete" }, 409);

    const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      password, user_metadata: { ...user.user_metadata, staff_activation_pending: false },
    });
    if (updateError) return json({ error: "Could not set the new password. Please retry." }, 400);
    const { error: profileUpdateError } = await admin.from("staff_profiles").update({ must_change_password: false, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("must_change_password", true);
    if (profileUpdateError) {
      console.error("complete-staff-setup profile update failed", { userId: user.id, code: profileUpdateError.code });
      return json({ error: "Password was changed but account finalization needs SuperAdmin assistance" }, 500);
    }
    await admin.from("audit_events").insert({ actor_user_id: user.id, event_type: "staff.first_login_password_changed", entity_type: "staff_profile", entity_id: user.id, details: {} });
    return json({ success: true });
  } catch (error) {
    console.error("complete-staff-setup error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
