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
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
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

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const client = createClient(url, anon, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userError } = await client.auth.getUser();
    const actor = userData.user;
    if (userError || !actor) return json({ error: "Invalid session" }, 401);

    const { data: actorProfile, error: actorProfileError } = await admin
      .from("staff_profiles").select("user_id").eq("user_id", actor.id).eq("active", true).maybeSingle();
    const { data: actorRoles, error: actorRolesError } = await admin
      .from("staff_role_assignments").select("role").eq("user_id", actor.id).eq("active", true);
    if (actorProfileError || actorRolesError) return json({ error: "Could not verify staff permissions" }, 500);
    if (!actorProfile || !actorRoles?.some((role) => role.role === "superadmin")) {
      return json({ error: "SuperAdmin access required" }, 403);
    }

    const body = await req.json();
    const targetId = String(body.target_user_id ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) {
      return json({ error: "Select a valid staff account" }, 400);
    }

    const { data: target, error: targetError } = await admin
      .from("staff_profiles")
      .select("user_id, username, full_name, active, must_change_password")
      .eq("user_id", targetId)
      .maybeSingle();
    if (targetError) return json({ error: "Could not verify the selected staff account" }, 500);
    if (!target?.active) return json({ error: "Only an active staff account can receive a new activation code" }, 404);

    const { data: authData, error: authLookupError } = await admin.auth.admin.getUserById(targetId);
    if (authLookupError || !authData.user) return json({ error: "Staff login was not found" }, 404);

    const code = activationCode();
    const { error: profileUpdateError } = await admin.from("staff_profiles")
      .update({ must_change_password: true, updated_at: new Date().toISOString() })
      .eq("user_id", targetId).eq("active", true);
    if (profileUpdateError) {
      console.error("reset-staff-activation-code profile update failed", { targetId, code: profileUpdateError.code });
      return json({ error: "Could not prepare the staff account for password setup" }, 500);
    }

    const { error: passwordUpdateError } = await admin.auth.admin.updateUserById(targetId, {
      password: code,
      user_metadata: { ...authData.user.user_metadata, staff_activation_pending: true },
    });
    if (passwordUpdateError) {
      await admin.from("staff_profiles")
        .update({ must_change_password: Boolean(target.must_change_password), updated_at: new Date().toISOString() })
        .eq("user_id", targetId);
      console.error("reset-staff-activation-code auth update failed", { targetId, message: passwordUpdateError.message });
      return json({ error: "Could not reset the staff login. No activation code was issued." }, 400);
    }

    const { error: auditError } = await admin.from("audit_events").insert({
      actor_user_id: actor.id,
      event_type: "staff.activation_code_reset",
      entity_type: "staff_profile",
      entity_id: targetId,
      details: { username: target.username, target_name: target.full_name },
    });
    if (auditError) console.error("reset-staff-activation-code audit insert failed", { targetId, code: auditError.code });

    return json({ success: true, username: target.username, activation_code: code }, 200);
  } catch (error) {
    console.error("reset-staff-activation-code error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
