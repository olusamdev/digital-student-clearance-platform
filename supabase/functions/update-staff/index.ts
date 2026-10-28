import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});

function normalizeWhatsAppPhone(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) throw new Error("Enter the officer's WhatsApp number with country code, e.g. 2348012345678.");
  return digits;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500, origin);
    const authorization = req.headers.get("authorization") ?? "";
    const client = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: authError } = await client.auth.getUser();
    if (authError || !userData.user) return json({ error: "Invalid session" }, 401, origin);

    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const actorId = userData.user.id;
    const [{ data: actorProfile, error: actorProfileError }, { data: actorRoles, error: actorRolesError }] = await Promise.all([
      admin.from("staff_profiles").select("user_id").eq("user_id", actorId).eq("active", true).maybeSingle(),
      admin.from("staff_role_assignments").select("role").eq("user_id", actorId).eq("active", true),
    ]);
    if (actorProfileError || actorRolesError) return json({ error: "Could not verify staff permissions" }, 500, origin);
    if (!actorProfile || !actorRoles?.some((r) => r.role === "superadmin")) return json({ error: "SuperAdmin access required" }, 403, origin);

    const body = await req.json().catch(() => ({}));
    const targetUserId = String(body.target_user_id ?? "").trim();
    const fullName = String(body.full_name ?? "").trim();
    const staffNumber = body.staff_number == null ? null : String(body.staff_number).trim() || null;
    let whatsappPhone: string | null;
    try { whatsappPhone = normalizeWhatsAppPhone(body.whatsapp_phone); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Invalid WhatsApp number" }, 400, origin); }
    const whatsappEnabled = body.whatsapp_enabled === true;
    if (!targetUserId || !fullName || fullName.length > 160 || (staffNumber && staffNumber.length > 80)) {
      return json({ error: "Provide a valid staff account, full name, and optional staff number" }, 400, origin);
    }
    if (whatsappEnabled && !whatsappPhone) return json({ error: "Enter a WhatsApp number before enabling WhatsApp clearance actions" }, 400, origin);

    const { data: target, error: targetError } = await admin.from("staff_profiles")
      .select("user_id,full_name,staff_number,whatsapp_phone,whatsapp_enabled").eq("user_id", targetUserId).maybeSingle();
    if (targetError || !target) return json({ error: "Staff account not found" }, 404, origin);

    const { error: updateError } = await admin.from("staff_profiles").update({
      full_name: fullName, staff_number: staffNumber, whatsapp_phone: whatsappPhone,
      whatsapp_enabled: whatsappEnabled, updated_at: new Date().toISOString(),
    }).eq("user_id", targetUserId);
    if (updateError) {
      if (updateError.code === "23505") return json({ error: "This WhatsApp number is already enabled for another officer" }, 409, origin);
      console.error("update-staff update failed", { code: updateError.code, message: updateError.message });
      return json({ error: "Staff details could not be updated" }, 500, origin);
    }

    await admin.from("audit_events").insert({
      actor_user_id: actorId, event_type: "staff.profile_updated", entity_type: "staff_profile", entity_id: targetUserId,
      details: {
        whatsapp_phone_changed: target.whatsapp_phone !== whatsappPhone,
        whatsapp_enabled_changed: target.whatsapp_enabled !== whatsappEnabled,
        whatsapp_enabled: whatsappEnabled,
        staff_number_supplied: Boolean(staffNumber),
      },
    });
    return json({ success: true, target_user_id: targetUserId, whatsapp_enabled: whatsappEnabled }, 200, origin);
  } catch (error) {
    console.error("update-staff error", error);
    return json({ error: "Unexpected server error" }, 500);
  }
});
