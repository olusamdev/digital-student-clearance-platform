import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const reply = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const text = (v: unknown, max = 200) => typeof v === "string" ? v.trim().slice(0, max) : "";

async function applyVerifiedPayment(admin: any, reference: string, secret: string, origin: string) {
  const { data: row, error: rowError } = await admin.from("payment_transactions")
    .select("id,session_student_id,registration_number_snapshot,payer_email,amount_kobo,currency,status")
    .eq("provider_reference", reference).eq("provider", "paystack").maybeSingle();
  if (rowError || !row) return { error: "Payment reference was not found.", status: 404 };
  const response = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + secret },
  });
  const result = await response.json().catch(() => ({}));
  const transaction = result?.data;
  if (!response.ok || result?.status !== true || transaction?.status !== "success") {
    if (row.status !== "successful") {
      await admin.from("payment_transactions").update({ status: "pending", updated_at: new Date().toISOString() }).eq("id", row.id);
    }
    return { error: "Paystack has not confirmed a successful payment yet. Retry verification shortly.", status: 409 };
  }
  const verifiedPayerEmail = text(transaction.customer?.email, 254).toLowerCase();
  if (!row.payer_email || !verifiedPayerEmail || verifiedPayerEmail !== String(row.payer_email).toLowerCase()) {
    await admin.from("payment_transactions").update({
      status: "pending", failure_reason: "Verified payer email mismatch",
      provider_payload: { status: transaction.status, customer_email: verifiedPayerEmail || null },
      updated_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { error: "The email confirmed by Paystack did not match the checkout email. Contact the college before attempting another payment.", status: 409 };
  }
  if (Number(transaction.amount) !== Number(row.amount_kobo) || String(transaction.currency).toUpperCase() !== row.currency) {
    await admin.from("payment_transactions").update({ status: "pending", failure_reason: "Verified amount or currency mismatch", provider_payload: { status: transaction.status, amount: transaction.amount, currency: transaction.currency }, updated_at: new Date().toISOString() }).eq("id", row.id);
    return { error: "Payment amount or currency did not match the expected clearance fee. Contact the college with the reference.", status: 409 };
  }
  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("payment_transactions").update({
    status: "successful", provider_transaction_id: String(transaction.id), verified_at: now,
    provider_payload: { status: transaction.status, amount: transaction.amount, currency: transaction.currency, paid_at: transaction.paid_at },
    failure_reason: null, updated_at: now,
  }).eq("id", row.id);
  if (updateError) return { error: "Payment was confirmed by Paystack but could not be recorded. Retry verification; do not pay again.", status: 500 };
  const { error: unlockError } = await admin.from("session_students").update({ payment_unlocked_at: now, updated_at: now }).eq("id", row.session_student_id);
  if (unlockError) return { error: "Payment was recorded but clearance access could not be updated. Retry verification; do not pay again.", status: 500 };
  await admin.from("audit_events").insert({
    actor_student_id: null, event_type: "student.payment_verified", entity_type: "payment_transaction", entity_id: row.id,
    details: { registration_number: row.registration_number_snapshot, provider_reference: reference, amount_kobo: row.amount_kobo },
  });
  return { success: true, registration_number: row.registration_number_snapshot, reference };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!url || !service || !secret) return reply({ error: "Payment service is not configured. Contact the college administrator." }, 503, origin);
  const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

  // Paystack webhooks are authenticated by their HMAC signature, not a Supabase JWT.
  if (req.method === "POST" && req.headers.has("x-paystack-signature")) {
    const raw = await req.text();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const expected = Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
    if (expected !== req.headers.get("x-paystack-signature")) return reply({ error: "Invalid webhook signature" }, 401);
    const event = JSON.parse(raw);
    if (event?.event === "charge.success" && event?.data?.reference) {
      const result = await applyVerifiedPayment(admin, String(event.data.reference), secret, "");
      if (result.error && result.status !== 404) console.error("Paystack webhook reconciliation failed", result.error);
    }
    return new Response("ok", { status: 200 });
  }

  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405, origin);
  const body = await req.json().catch(() => ({}));
  const action = text(body?.action);
  const payload = body?.payload && typeof body.payload === "object" ? body.payload : {};
  if (action === "verify") {
    const reference = text(payload.reference, 200);
    if (!reference) return reply({ error: "Payment reference is required." }, 400, origin);
    const result = await applyVerifiedPayment(admin, reference, secret, origin);
    return result.error ? reply({ error: result.error }, result.status, origin) : reply(result, 200, origin);
  }
  const adminInitiated = action === "initiate_admin";
  if (action !== "initiate" && !adminInitiated) return reply({ error: "Unsupported payment action." }, 400, origin);

  const registrationNumber = text(payload.registration_number, 100).toUpperCase();
  let email = "";
  let actorUserId: string | null = null;
  if (adminInitiated) {
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return reply({ error: "Administrator sign-in is required." }, 401, origin);
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (!anon) return reply({ error: "Server configuration incomplete." }, 500, origin);
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return reply({ error: "Administrator session is invalid." }, 401, origin);
    const [{ data: profile }, { data: roles }] = await Promise.all([
      admin.from("staff_profiles").select("user_id,active").eq("user_id", authData.user.id).maybeSingle(),
      admin.from("staff_role_assignments").select("role").eq("user_id", authData.user.id).eq("active", true).in("role", ["admin", "superadmin"]),
    ]);
    if (!profile?.active || !roles?.length) return reply({ error: "Only an active Administrator or SuperAdmin can pay for a student." }, 403, origin);
    actorUserId = authData.user.id;
    email = text(authData.user.email, 254).toLowerCase();
  } else {
    // Students do not need personal email accounts. Use the college-controlled Paystack receipt address.
    email = text(Deno.env.get("PAYSTACK_RECEIPT_EMAIL"), 254).toLowerCase();
  }
  if (!registrationNumber) return reply({ error: "Enter the student's registration number." }, 400, origin);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return reply({ error: adminInitiated
      ? "The signed-in staff account needs a valid email for the Paystack receipt."
      : "Student payments are not configured yet. Contact the college or ask an administrator to assist with payment." }, adminInitiated ? 400 : 503, origin);
  }
  const { data: student, error: studentError } = await admin.from("student_records").select("id,registration_number,full_name,auth_user_id")
    .eq("registration_number", registrationNumber).maybeSingle();
  if (studentError || !student) return reply({ error: "No student record was found. Check the registration number." }, 404, origin);
  const { data: sessions, error: sessionError } = await admin.from("clearance_sessions").select("id,name,active,opens_at,closes_at").eq("active", true);
  if (sessionError) return reply({ error: "Could not check clearance availability." }, 500, origin);
  const nowDate = Date.now();
  const session = (sessions ?? []).find((item) => (!item.opens_at || new Date(item.opens_at).getTime() <= nowDate) && (!item.closes_at || new Date(item.closes_at).getTime() >= nowDate));
  if (!session) return reply({ error: "There is no open clearance session for payment at this time." }, 409, origin);
  const { data: feeSetting } = await admin.from("app_settings").select("setting_value").eq("setting_key", "clearance_fee_kobo").maybeSingle();
  const amountKobo = Number(feeSetting?.setting_value ?? 170000);
  if (!Number.isSafeInteger(amountKobo) || amountKobo < 100) return reply({ error: "The college clearance fee is not configured correctly." }, 503, origin);

  let { data: link, error: linkError } = await admin.from("session_students").select("id,payment_unlocked_at")
    .eq("session_id", session.id).eq("student_id", student.id).maybeSingle();
  if (linkError) return reply({ error: "Could not prepare your clearance session." }, 500, origin);
  if (!link) {
    const created = await admin.from("session_students").insert({ session_id: session.id, student_id: student.id }).select("id,payment_unlocked_at").single();
    link = created.data;
    linkError = created.error;
  }
  if (linkError || !link) return reply({ error: "Could not prepare your clearance session." }, 500, origin);
  if (link.payment_unlocked_at) return reply({ success: true, already_paid: true, registration_number: student.registration_number }, 200, origin);

  const { data: prior } = await admin.from("payment_transactions").select("id,status,provider_reference")
    .eq("session_student_id", link.id).eq("provider", "paystack").in("status", ["initiated", "pending", "successful"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (prior) {
    const verified = await applyVerifiedPayment(admin, prior.provider_reference, secret, origin);
    if (!verified.error) return reply({ success: true, already_paid: true, registration_number: student.registration_number }, 200, origin);
    // Do not create a second charge while the earlier transaction remains unresolved.
    return reply({ error: "A previous payment is still being reconciled. Retry payment verification before starting another payment.", reference: prior.provider_reference }, 409, origin);
  }

  const reference = "DSCP-" + crypto.randomUUID();
  const callbackUrl = Deno.env.get("PAYSTACK_CALLBACK_URL") || "https://dscp.olusamdev.workers.dev/student";
  const paystackResponse = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({ email, amount: amountKobo, currency: "NGN", reference, callback_url: callbackUrl, metadata: { registration_number: student.registration_number, session_student_id: link.id, purpose: "student_clearance_fee" } }),
  });
  const initialized = await paystackResponse.json().catch(() => ({}));
  if (!paystackResponse.ok || initialized?.status !== true || !initialized?.data?.authorization_url) return reply({ error: "Paystack could not start payment. Please try again." }, 502, origin);
  const { error: insertError } = await admin.from("payment_transactions").insert({
    session_student_id: link.id, provider: "paystack", provider_reference: reference, amount_kobo: amountKobo,
    currency: "NGN", status: "pending", registration_number_snapshot: student.registration_number, payer_email: email,
    initiated_by_user_id: actorUserId, payment_mode: adminInitiated ? "admin_assisted" : "student_initiated",
    provider_payload: { access_code: initialized.data.access_code }, initiated_at: new Date().toISOString(),
  });
  if (insertError) return reply({ error: "Payment was initialized but could not be safely recorded. Contact the college before retrying." }, 500, origin);
  await admin.from("audit_events").insert({
    actor_student_id: adminInitiated ? null : student.id,
    event_type: adminInitiated ? "admin.student_payment_initiated" : "student.payment_initiated",
    entity_type: "payment_transaction", entity_id: reference,
    details: { registration_number: student.registration_number, amount_kobo: amountKobo, initiated_by: actorUserId, payment_mode: adminInitiated ? "admin_assisted" : "student_initiated" },
  });
  return reply({ success: true, authorization_url: initialized.data.authorization_url, reference, registration_number: student.registration_number }, 200, origin);
});