import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const respond = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const str = (v: unknown, n = 200) => typeof v === "string" ? v.trim().slice(0, n) : "";
const reg = (v: unknown) => str(v, 100).toUpperCase();
async function hash(v: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
  return Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
}
function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), b => chars[b % chars.length]).join("");
}
async function internalEmail(registrationNumber: string) {
  return "student-" + (await hash(registrationNumber)).slice(0, 32) + "@students.dscp.invalid";
}
async function hasCurrentPaidSession(db: any, studentId: string) {
  const { data: sessions, error: sessionsError } = await db.from("clearance_sessions")
    .select("id,opens_at,closes_at").eq("active", true);
  if (sessionsError) return { error: true, paid: false };
  const now = Date.now();
  const currentIds = (sessions ?? []).filter((session: any) =>
    (!session.opens_at || new Date(session.opens_at).getTime() <= now) &&
    (!session.closes_at || new Date(session.closes_at).getTime() >= now)
  ).map((session: any) => session.id);
  if (!currentIds.length) return { error: false, paid: false };
  const { data: links, error: linksError } = await db.from("session_students").select("id")
    .eq("student_id", studentId).in("session_id", currentIds).not("payment_unlocked_at", "is", null).limit(1);
  if (linksError) return { error: true, paid: false };
  return { error: false, paid: Boolean(links?.length) };
}

Deno.serve(async req => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return respond({ error: "Method not allowed" }, 405, origin);
  try {
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY"), service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return respond({ error: "Server configuration incomplete" }, 500, origin);
    const body = await req.json().catch(() => ({}));
    const action = str(body.action);
    const p = body.payload && typeof body.payload === "object" ? body.payload : {};
    const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    if (action === "get_support_number") {
      const { data, error } = await db.from("app_settings").select("setting_value").eq("setting_key", "student_support_whatsapp").maybeSingle();
      if (error) return respond({ error: "Support contact is temporarily unavailable." }, 500, origin);
      return respond({ success: true, whatsapp: str(data?.setting_value, 40) }, 200, origin);
    }

    if (action === "complete_student_activation") {
      const registrationNumber = reg(p.registration_number);
      const password = typeof p.password === "string" ? p.password : "";
      if (!registrationNumber || password.length < 8) return respond({ error: "Enter your registration number and a password of at least 8 characters." }, 400, origin);
      const { data: student, error: studentError } = await db.from("student_records")
        .select("id,registration_number,auth_user_id").eq("registration_number", registrationNumber).maybeSingle();
      if (studentError) return respond({ error: "Could not verify the student record." }, 500, origin);
      if (!student) return respond({ error: "Student record not found." }, 404, origin);
      if (student.auth_user_id) return respond({ error: "This account is already activated. Contact an administrator if you cannot sign in." }, 409, origin);
      const { data: sessions, error: sessionsError } = await db.from("clearance_sessions")
        .select("id,opens_at,closes_at").eq("active", true);
      if (sessionsError) return respond({ error: "Could not verify the clearance session." }, 500, origin);
      const nowMs = Date.now();
      const currentSessionIds = (sessions ?? []).filter((session: any) =>
        (!session.opens_at || new Date(session.opens_at).getTime() <= nowMs) &&
        (!session.closes_at || new Date(session.closes_at).getTime() >= nowMs)
      ).map((session: any) => session.id);
      if (!currentSessionIds.length) return respond({ error: "There is no open clearance session for account activation." }, 402, origin);
      const { data: links, error: linksError } = await db.from("session_students")
        .select("id,session_id,payment_unlocked_at").eq("student_id", student.id)
        .in("session_id", currentSessionIds).not("payment_unlocked_at", "is", null);
      if (linksError) return respond({ error: "Could not verify the clearance payment." }, 500, origin);
      if (!links?.length) return respond({ error: "A verified payment for the active clearance session is required before account activation." }, 402, origin);
      const { data: payments, error: paymentsError } = await db.from("payment_transactions")
        .select("id,payment_mode,status,created_at").in("session_student_id", links.map((link: any) => link.id))
        .eq("status", "successful")
        .order("created_at", { ascending: false }).limit(1);
      if (paymentsError) return respond({ error: "Could not verify how the clearance fee was paid." }, 500, origin);
      if (!payments?.length) return respond({ error: "A successful verified payment is required before account activation." }, 402, origin);
      const email = await internalEmail(student.registration_number);
      const now = new Date().toISOString();
      const { data: created, error: createError } = await db.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { registration_number: student.registration_number, account_type: "student" },
      });
      if (createError || !created.user) return respond({ error: "Account setup failed. Contact the college administrator for assistance." }, 500, origin);
      const { data: linked, error: linkError } = await db.from("student_records").update({
        auth_user_id: created.user.id, auth_email: email, account_setup_completed_at: now, updated_at: now,
      }).eq("id", student.id).is("auth_user_id", null).select("id").maybeSingle();
      if (linkError || !linked) {
        await db.auth.admin.deleteUser(created.user.id);
        return respond({ error: "Could not link the account safely. Contact the college." }, 409, origin);
      }
      await db.from("audit_events").insert({
        actor_student_id: student.id, event_type: "student.account_activated", entity_type: "student_record",
        entity_id: student.id, details: { registration_number: student.registration_number, activation_method: "verified_clearance_payment" },
      });
      return respond({ success: true, activated: true, auth_email: email }, 200, origin);
    }

    if (action === "complete_password_reset") {
      const registrationNumber = reg(p.registration_number), suppliedCode = str(p.code, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
      const password = typeof p.password === "string" ? p.password : "";
      if (!registrationNumber || suppliedCode.length < 8 || password.length < 8) return respond({ error: "Enter your registration number, code, and a password of at least 8 characters." }, 400, origin);
      const { data: student, error: studentError } = await db.from("student_records").select("id,registration_number,auth_user_id").eq("registration_number", registrationNumber).maybeSingle();
      if (studentError) return respond({ error: "Could not verify the student record." }, 500, origin);
      if (!student) return respond({ error: "Student record not found." }, 404, origin);
      if (!student.auth_user_id) return respond({ error: "This account has not been activated." }, 409, origin);
      const purpose = "password_reset";
      const tokenHash = await hash(purpose + ":" + student.id + ":" + suppliedCode);
      const { data: token, error: tokenError } = await db.from("student_access_tokens").select("id,expires_at,consumed_at")
        .eq("student_id", student.id).eq("purpose", purpose).eq("token_hash", tokenHash).maybeSingle();
      if (tokenError) return respond({ error: "Could not verify the code." }, 500, origin);
      if (!token || token.consumed_at || new Date(token.expires_at).getTime() <= Date.now()) return respond({ error: "Code is invalid, expired, or already used. Request a new code from the college." }, 403, origin);
      const now = new Date().toISOString();
      const { data: claimed, error: claimError } = await db.from("student_access_tokens").update({ consumed_at: now })
        .eq("id", token.id).is("consumed_at", null).gt("expires_at", now).select("id").maybeSingle();
      if (claimError || !claimed) return respond({ error: "Code has already been used or expired. Request a new code." }, 409, origin);
      const { error: passwordError } = await db.auth.admin.updateUserById(student.auth_user_id, { password });
      if (passwordError) return respond({ error: "Password reset failed. Ask the college to issue a new code." }, 500, origin);
      await db.from("audit_events").insert({ actor_student_id: student.id, event_type: "student.password_reset_completed", entity_type: "student_record", entity_id: student.id, details: { registration_number: student.registration_number } });
      return respond({ success: true, password_reset: true }, 200, origin);
    }

    const auth = req.headers.get("Authorization");
    if (!auth?.startsWith("Bearer ")) return respond({ error: "Authentication required" }, 401, origin);
    const userClient = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData.user) return respond({ error: "Invalid session" }, 401, origin);
    const actor = userData.user;



    const [{ data: profile, error: profileError }, { data: roles, error: rolesError }] = await Promise.all([
      db.from("staff_profiles").select("user_id,active").eq("user_id", actor.id).maybeSingle(),
      db.from("staff_role_assignments").select("role").eq("user_id", actor.id).eq("active", true).in("role", ["admin", "superadmin"]),
    ]);
    if (profileError || rolesError) return respond({ error: "Could not verify staff permissions." }, 500, origin);
    if (!profile?.active || !roles?.length) return respond({ error: "Only an active Administrator or SuperAdmin can perform this action." }, 403, origin);
    const superAdmin = roles.some(r => r.role === "superadmin");

    if (action === "set_support_number") {
      if (!superAdmin) return respond({ error: "Only the SuperAdmin can change the support number." }, 403, origin);
      const whatsapp = str(p.whatsapp, 40).replace(/[\s()+.-]/g, "");
      if (whatsapp && !/^\d{10,15}$/.test(whatsapp)) return respond({ error: "Enter the WhatsApp number with country code, digits only." }, 400, origin);
      const { error } = await db.from("app_settings").upsert({ setting_key: "student_support_whatsapp", setting_value: whatsapp, updated_at: new Date().toISOString() }, { onConflict: "setting_key" });
      if (error) return respond({ error: "Could not save the support number." }, 500, origin);
      await db.from("audit_events").insert({ actor_student_id: null, event_type: "superadmin.student_support_number_changed", entity_type: "app_setting", entity_id: "student_support_whatsapp", details: { changed_by: actor.id, configured: Boolean(whatsapp) } });
      return respond({ success: true, whatsapp }, 200, origin);
    }

    if (action === "issue_password_reset") {
      const registrationNumber = reg(p.registration_number);
      if (!registrationNumber) return respond({ error: "Enter the student's registration number." }, 400, origin);
      const { data: student, error: studentError } = await db.from("student_records").select("id,registration_number,full_name,auth_user_id").eq("registration_number", registrationNumber).maybeSingle();
      if (studentError) return respond({ error: "Could not check the student record." }, 500, origin);
      if (!student) return respond({ error: "Student record not found." }, 404, origin);
      if (!student.auth_user_id) return respond({ error: "This account has not been activated." }, 409, origin);
      const purpose = "password_reset";
      await db.from("student_access_tokens").update({ consumed_at: new Date().toISOString() }).eq("student_id", student.id).eq("purpose", purpose).is("consumed_at", null);
      const rawCode = code(), tokenHash = await hash(purpose + ":" + student.id + ":" + rawCode);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const { error: insertError } = await db.from("student_access_tokens").insert({ student_id: student.id, purpose, token_hash: tokenHash, expires_at: expiresAt, issued_by: actor.id });
      if (insertError) return respond({ error: "Could not issue a secure code." }, 500, origin);
      await db.from("audit_events").insert({ actor_student_id: student.id, event_type: "admin.student_password_reset_issued", entity_type: "student_record", entity_id: student.id, details: { registration_number: student.registration_number, issued_by: actor.id, expires_at: expiresAt } });
      return respond({ success: true, code: rawCode, expires_at: expiresAt, student: { full_name: student.full_name, registration_number: student.registration_number } }, 200, origin);
    }
    return respond({ error: "Unsupported student access action." }, 400, origin);
  } catch (error) {
    console.error("manage-student-access failed", error);
    return respond({ error: "Unexpected server error" }, 500, req.headers.get("origin") ?? "");
  }
});
