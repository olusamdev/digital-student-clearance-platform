import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

type Json = Record<string, unknown>;
const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status,
  headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});

function canonicalPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 11) return "+234" + digits.slice(1);
  if (digits.length === 10) return "+234" + digits;
  if (value.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15) return "+" + digits;
  return "";
}
function phoneVariants(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return [phone, digits, "0" + digits.slice(3), digits.slice(3)];
  return [phone, digits];
}
function text(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  const headers = corsHeaders(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  try {
    const url = Deno.env.get("SUPABASE_URL");
    const anon = Deno.env.get("SUPABASE_ANON_KEY");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({ error: "Server configuration incomplete" }, 500, origin);
    const body = await req.json().catch(() => ({})) as Json;
    const action = String(body.action ?? "");
    const payload = body.payload && typeof body.payload === "object" && body.payload !== null ? body.payload as Json : {};
    const sessionStudentId = text(payload.session_student_id, 80);
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

    // Registration lookup is deliberately unauthenticated; it returns only the imported name
    // and account/payment state. It never grants access to biodata or clearance records.
    if (action === "lookup_record") {
      const registrationNumber = text(payload.registration_number, 100).toUpperCase();
      if (!registrationNumber) return json({ error: "Enter your registration number." }, 400, origin);
      const { data: candidate, error: lookupError } = await admin.from("student_records")
        .select("id,registration_number,full_name,auth_user_id,auth_email")
        .eq("registration_number", registrationNumber).maybeSingle();
      if (lookupError) return json({ error: "Could not check that registration number. Please try again." }, 500, origin);
      if (!candidate) return json({ error: "No student record was found. Check the registration number or contact the college." }, 404, origin);
      const { data: activeSessions, error: sessionsError } = await admin.from("clearance_sessions")
        .select("id,name,academic_session,active,opens_at,closes_at").eq("active", true).limit(10);
      if (sessionsError) return json({ error: "Could not check clearance availability. Please try again." }, 500, origin);
      const feeSetting = await admin.from("app_settings").select("setting_value").eq("setting_key", "clearance_fee_kobo").maybeSingle();
      const feeValue = Number(feeSetting.data?.setting_value ?? 170000);
      const activeSession = (activeSessions ?? []).find((item) => {
        const now = Date.now();
        return (!item.opens_at || new Date(item.opens_at).getTime() <= now) &&
          (!item.closes_at || new Date(item.closes_at).getTime() >= now);
      }) ?? null;
      const { data: studentSessions, error: studentSessionsError } = await admin.from("session_students")
        .select("id,session_id,payment_unlocked_at").eq("student_id", candidate.id);
      if (studentSessionsError) return json({ error: "Could not check your payment status. Please try again." }, 500, origin);
      const links = studentSessions ?? [];
      const activeLinks = activeSession ? links.filter((link) => link.session_id === activeSession.id) : [];
      const paymentVerified = activeLinks.some((link) => Boolean(link.payment_unlocked_at));
      let paymentPending = false;
      const activationRequiresCode = false;
      if (activeLinks.length) {
        const { data: transactions, error: transactionError } = await admin.from("payment_transactions")
          .select("status,payment_mode,created_at").in("session_student_id", activeLinks.map((link) => link.id))
          .order("created_at", { ascending: false }).limit(10);
        if (transactionError) return json({ error: "Could not check your payment status. Please try again." }, 500, origin);
        paymentPending = !paymentVerified && (transactions ?? []).some((item) => ["pending", "initiated", "successful"].includes(item.status));
      }
      return json({
        success: true,
        student: { registration_number: candidate.registration_number, full_name: candidate.full_name },
        account_ready: Boolean(candidate.auth_user_id && candidate.auth_email),
        auth_email: candidate.auth_user_id && candidate.auth_email ? candidate.auth_email : null,
        payment_verified: paymentVerified,
        payment_pending: paymentPending,
        activation_requires_code: activationRequiresCode,
        clearance_fee_kobo: Number.isFinite(feeValue) && feeValue > 0 ? feeValue : 170000,
        session_available: Boolean(activeSession),
      }, 200, origin);
    }

    if (action === "validate_payment_email") {
      const registrationNumber = text(payload.registration_number, 100).toUpperCase();
      const email = text(payload.email, 254).toLowerCase();
      if (!registrationNumber || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
        return json({ error: "Enter the registration number and the email used for payment." }, 400, origin);
      }
      const { data: candidate, error: candidateError } = await admin.from("student_records")
        .select("id,registration_number,auth_user_id").eq("registration_number", registrationNumber).maybeSingle();
      if (candidateError) return json({ error: "Could not check the payment details." }, 500, origin);
      if (!candidate) return json({ error: "The registration number and payment email could not be verified together." }, 403, origin);
      if (candidate.auth_user_id) return json({ error: "This student record already has an account. Sign in or use password recovery." }, 409, origin);
      const { data: paidRows, error: paidError } = await admin.from("payment_transactions")
        .select("id,session_student_id").eq("registration_number_snapshot", candidate.registration_number)
        .eq("payer_email", email).eq("status", "successful").order("verified_at", { ascending: false }).limit(10);
      if (paidError) return json({ error: "Could not check the payment details." }, 500, origin);
      for (const payment of paidRows ?? []) {
        const { data: paidSession } = await admin.from("session_students").select("student_id,payment_unlocked_at")
          .eq("id", payment.session_student_id).maybeSingle();
        if (paidSession && paidSession.student_id === candidate.id && paidSession.payment_unlocked_at) {
          return json({ success: true, valid: true }, 200, origin);
        }
      }
      return json({ error: "That email does not match a verified clearance payment for this registration number. Use the receipt email, or contact the college if you need help." }, 403, origin);
    }

    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, origin);
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    const user = authData.user;
    if (authError || !user) return json({ error: "Sign in to access your student account." }, 401, origin);
    // A staff identity must never be treated as a student identity, even if a phone number is shared.
    const [{ data: staffProfile }, { data: staffAssignment }] = await Promise.all([
      admin.from("staff_profiles").select("user_id").eq("user_id", user.id).maybeSingle(),
      admin.from("staff_role_assignments").select("user_id").eq("user_id", user.id).eq("active", true).limit(1).maybeSingle(),
    ]);
    if (staffProfile || staffAssignment) return json({ error: "Staff accounts cannot access the student portal. Sign out and use the staff workspace." }, 403, origin);

    if (action === "link_account") {
      const email = text(user.email, 254).toLowerCase();
      if (!email || !user.email_confirmed_at) {
        return json({ error: "Verify your email address before completing account setup." }, 403, origin);
      }
      const { data: existingLink, error: existingLinkError } = await admin.from("student_records")
        .select("id,registration_number,auth_email").eq("auth_user_id", user.id).maybeSingle();
      if (existingLinkError) return json({ error: "Could not verify your student account link." }, 500, origin);
      if (existingLink) {
        if ((existingLink.auth_email ?? "").toLowerCase() !== email) {
          return json({ error: "The verified email does not match the email linked to this account. Contact the college." }, 409, origin);
        }
        return json({ success: true, linked: true }, 200, origin);
      }
      const registrationNumber = text(user.user_metadata?.registration_number, 100).toUpperCase();
      if (!registrationNumber) return json({ error: "Student setup could not be resumed. Return to the Student Portal and start again." }, 400, origin);
      const { data: candidate, error: candidateError } = await admin.from("student_records")
        .select("id,registration_number,auth_user_id").eq("registration_number", registrationNumber).maybeSingle();
      if (candidateError) return json({ error: "Could not verify the imported student record." }, 500, origin);
      if (!candidate) return json({ error: "No imported student record matches this account." }, 404, origin);
      if (candidate.auth_user_id && candidate.auth_user_id !== user.id) {
        return json({ error: "This student record is already linked to another account. Contact the college for recovery." }, 409, origin);
      }
      const { data: paidRows, error: paidError } = await admin.from("payment_transactions")
        .select("id,session_student_id,registration_number_snapshot,payer_email,status")
        .eq("registration_number_snapshot", candidate.registration_number)
        .eq("payer_email", email).eq("status", "successful").order("verified_at", { ascending: false }).limit(10);
      if (paidError) return json({ error: "Could not verify the payment linked to this email." }, 500, origin);
      let validPayment = false;
      for (const payment of paidRows ?? []) {
        const { data: paidSession } = await admin.from("session_students").select("student_id,payment_unlocked_at")
          .eq("id", payment.session_student_id).maybeSingle();
        if (paidSession && paidSession.student_id === candidate.id && paidSession.payment_unlocked_at) { validPayment = true; break; }
      }
      if (!validPayment) return json({ error: "Use the same verified email address that received the Paystack payment receipt for this registration number." }, 403, origin);
      const now = new Date().toISOString();
      const { data: linkedRecord, error: linkError } = await admin.from("student_records").update({
        auth_user_id: user.id, auth_email: email, recovery_email: email,
        recovery_email_verified_at: now, account_setup_completed_at: now, updated_at: now,
      }).eq("id", candidate.id).is("auth_user_id", null).select("id").maybeSingle();
      if (linkError || !linkedRecord) {
        console.error("student-portal account link failed", { code: linkError?.code ?? "record_already_linked" });
        return json({ error: "Could not safely link this student account. Contact the college if this persists." }, 409, origin);
      }
      await admin.from("audit_events").insert({
        actor_student_id: candidate.id, event_type: "student.account_linked", entity_type: "student_record",
        entity_id: candidate.id, details: { registration_number: candidate.registration_number, verified_email: email },
      });
      return json({ success: true, linked: true }, 200, origin);
    }

    const { data: student, error: studentError } = await admin.from("student_records")
      .select("id,registration_number,full_name,department_id,programme_id,gender,permanent_address,phone_number,auth_user_id")
      .eq("auth_user_id", user.id).maybeSingle();
    if (studentError) {
      console.error("student-portal student lookup failed", { code: studentError.code });
      return json({ error: "Could not load your student account. Please try again later." }, 500, origin);
    }
    if (!student) return json({ error: "This account is not linked to a student record. Use the Student Portal registration lookup or contact the college." }, 403, origin);

    if (action === "confirm_profile") {
      if (!sessionStudentId) return json({ error: "Clearance session is required." }, 400, origin);
      const { data: link, error: linkError } = await admin.from("session_students").select("id,session_id,student_id").eq("id", sessionStudentId).eq("student_id", student.id).maybeSingle();
      if (linkError || !link) return json({ error: "Clearance session not found for this student." }, 404, origin);
      const fullName = text(payload.full_name, 160);
      const genderInput = text(payload.gender, 40).toLowerCase();
      if (genderInput && genderInput !== "male" && genderInput !== "female") return json({ error: "Select Male or Female for gender." }, 400, origin);
      const gender = genderInput || null;
      const address = text(payload.permanent_address, 500);
      const departmentId = text(payload.department_id, 80);
      const programmeId = text(payload.programme_id, 80);
      if (fullName.length < 2) return json({ error: "Enter your full name." }, 400, origin);
      if (!departmentId || !programmeId) return json({ error: "Select your department and programme." }, 400, origin);
      const [{ data: department, error: departmentError }, { data: programme, error: programmeError }] = await Promise.all([
        admin.from("departments").select("id,active").eq("id", departmentId).maybeSingle(),
        admin.from("programmes").select("id,department_id,active").eq("id", programmeId).maybeSingle(),
      ]);
      if (departmentError || programmeError) return json({ error: "Could not validate your department and programme." }, 500, origin);
      if (!department?.active || !programme?.active || programme.department_id !== department.id) return json({ error: "Choose an active programme under your selected department." }, 400, origin);
      const { error: updateStudentError } = await admin.from("student_records").update({ full_name: fullName, department_id: department.id, programme_id: programme.id, gender, permanent_address: address || null, profile_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", student.id);
      if (updateStudentError) {
        console.error("student-portal profile update failed", { code: updateStudentError.code });
        return json({ error: "Could not save your particulars." }, 500, origin);
      }
      const { error: updateLinkError } = await admin.from("session_students").update({ profile_confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", link.id).eq("student_id", student.id);
      if (updateLinkError) return json({ error: "Particulars were saved, but session confirmation failed. Refresh and retry." }, 500, origin);
      await admin.from("audit_events").insert({ actor_student_id: student.id, event_type: "student.profile_confirmed", entity_type: "student_record", entity_id: student.id, details: { session_student_id: link.id } });
      return json({ success: true }, 200, origin);
    }

    if (action === "request_clearance") {
      if (!sessionStudentId) return json({ error: "Clearance session is required." }, 400, origin);
      const { data: link, error: linkError } = await admin.from("session_students").select("id,session_id,student_id,payment_unlocked_at,profile_confirmed_at,final_assent").eq("id", sessionStudentId).eq("student_id", student.id).maybeSingle();
      if (linkError || !link) return json({ error: "Clearance session not found for this student." }, 404, origin);
      if (!link.profile_confirmed_at) return json({ error: "Confirm your particulars before requesting clearance." }, 400, origin);
      if (!link.payment_unlocked_at) return json({ error: "Clearance is locked until the college verifies your clearance-fee payment." }, 402, origin);
      if (link.final_assent === "assented") return json({ error: "This clearance has already been completed." }, 409, origin);
      const { data: requirements, error: requirementsError } = await admin.from("clearance_requirements").select("id,office_id,department_id,programme_id,required,enabled").eq("session_id", link.session_id).eq("enabled", true).eq("required", true);
      if (requirementsError) return json({ error: "Could not load clearance requirements." }, 500, origin);
      const applicable = (requirements ?? []).filter((r) => (!r.department_id || r.department_id === student.department_id) && (!r.programme_id || r.programme_id === student.programme_id));
      if (!applicable.length) return json({ error: "The college has not configured required clearance offices for this session. Contact the administrator." }, 409, origin);
      const { data: existing, error: existingError } = await admin.from("clearance_requests").select("id,requirement_id,status").eq("session_student_id", link.id);
      if (existingError) return json({ error: "Could not load your existing clearance requests." }, 500, origin);
      for (const requirement of applicable) {
        const current = (existing ?? []).find((r) => r.requirement_id === requirement.id);
        if (!current) {
          const { error: insertError } = await admin.from("clearance_requests").insert({ session_student_id: link.id, requirement_id: requirement.id, status: "requested", requested_at: new Date().toISOString() });
          if (insertError) {
            console.error("student-portal request insert failed", { code: insertError.code });
            return json({ error: "A clearance request could not be submitted. Refresh the portal and try again." }, 500, origin);
          }
        } else if (current.status === "not_requested" || current.status === "needs_attention") {
          const { error: updateError } = await admin.from("clearance_requests").update({ status: "requested", requested_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", current.id).eq("session_student_id", link.id);
          if (updateError) return json({ error: "A clearance request could not be resubmitted. Please contact the clearance office." }, 500, origin);
        }
      }
      await admin.from("audit_events").insert({ actor_student_id: student.id, event_type: "student.clearance_submitted", entity_type: "session_student", entity_id: link.id, details: { requirement_count: applicable.length } });
      return json({ success: true, submitted_count: applicable.length }, 200, origin);
    }

    if (action !== "dashboard") return json({ error: "Unsupported student portal action." }, 400, origin);

    const { data: links, error: linksError } = await admin.from("session_students").select("id,session_id,payment_unlocked_at,profile_confirmed_at,final_assent,final_assent_remarks,completed_at").eq("student_id", student.id);
    if (linksError) return json({ error: "Could not load your clearance sessions." }, 500, origin);
    const sessionLinks = links ?? [];
    const sessionIds = sessionLinks.map((link) => link.session_id);
    const linkIds = sessionLinks.map((link) => link.id);
    const { data: sessions, error: sessionsError } = sessionIds.length
      ? await admin.from("clearance_sessions").select("id,name,academic_session,active,opens_at,closes_at").in("id", sessionIds)
      : { data: [], error: null };
    if (sessionsError) return json({ error: "Could not load clearance session details." }, 500, origin);
    const { data: requirements, error: reqError } = sessionIds.length
      ? await admin.from("clearance_requirements").select("id,session_id,office_id,department_id,programme_id,required,enabled,instructions,display_order,clearance_offices(name,code)").in("session_id", sessionIds).eq("enabled", true).order("display_order")
      : { data: [], error: null };
    if (reqError) return json({ error: "Could not load clearance requirements." }, 500, origin);
    const { data: requests, error: requestsError } = linkIds.length
      ? await admin.from("clearance_requests").select("id,session_student_id,requirement_id,status,requested_at,decision_at").in("session_student_id", linkIds)
      : { data: [], error: null };
    if (requestsError) return json({ error: "Could not load clearance status." }, 500, origin);
    const requestIds = (requests ?? []).map((r) => r.id);
    const { data: comments, error: commentsError } = requestIds.length
      ? await admin.from("clearance_comments").select("id,clearance_request_id,comment_text,author_role,created_at").in("clearance_request_id", requestIds).eq("visible_to_student", true).order("created_at")
      : { data: [], error: null };
    if (commentsError) return json({ error: "Could not load clearance remarks." }, 500, origin);
    const { data: feeSetting } = await admin.from("app_settings").select("setting_value").eq("setting_key", "clearance_fee_kobo").maybeSingle();
    const feeValue = Number(feeSetting?.setting_value ?? 170000);
    const feeKobo = Number.isFinite(feeValue) && feeValue > 0 ? feeValue : 170000;
    const sessionRows = sessionLinks.map((link) => {
      const info = (sessions ?? []).find((s) => s.id === link.session_id) as any;
      const rowRequirements = (requirements ?? []).filter((r) => r.session_id === link.session_id && (!r.department_id || r.department_id === student.department_id) && (!r.programme_id || r.programme_id === student.programme_id));
      return {
        ...link,
        session_name: info?.name ?? "Clearance session",
        academic_session: info?.academic_session ?? null,
        active: Boolean(info?.active),
        opens_at: info?.opens_at ?? null,
        closes_at: info?.closes_at ?? null,
        requirements: rowRequirements.map((r) => {
          const request = (requests ?? []).find((x) => x.session_student_id === link.id && x.requirement_id === r.id);
          const office = Array.isArray(r.clearance_offices) ? r.clearance_offices[0] : r.clearance_offices;
          return {
            id: r.id,
            request_id: request?.id ?? null,
            office_name: office?.name ?? "Clearance office",
            office_code: office?.code ?? "",
            instructions: r.instructions,
            required: r.required,
            status: request?.status ?? "not_requested",
            requested_at: request?.requested_at ?? null,
            decision_at: request?.decision_at ?? null,
            comments: (comments ?? []).filter((c) => c.clearance_request_id === request?.id).map((c) => ({ id: c.id, comment_text: c.comment_text, author_role: c.author_role, created_at: c.created_at })),
          };
        }),
      };
    });
    const { data: dept } = student.department_id ? await admin.from("departments").select("name").eq("id", student.department_id).maybeSingle() : { data: null };
    const { data: programme } = student.programme_id ? await admin.from("programmes").select("name").eq("id", student.programme_id).maybeSingle() : { data: null };
    const [{ data: departments, error: departmentsError }, { data: programmes, error: programmesError }] = await Promise.all([
      admin.from("departments").select("id,code,name").eq("active", true).order("name"),
      admin.from("programmes").select("id,department_id,code,name").eq("active", true).order("name"),
    ]);
    if (departmentsError || programmesError) return json({ error: "Could not load department and programme options." }, 500, origin);
    return json({
      student: { id: student.id, registration_number: student.registration_number, full_name: student.full_name, gender: student.gender, permanent_address: student.permanent_address, department_id: student.department_id, programme_id: student.programme_id, department: dept?.name ?? null, programme: programme?.name ?? null, phone_number: student.phone_number },
      departments: departments ?? [],
      programmes: programmes ?? [],
      clearance_fee_kobo: feeKobo,
      sessions: sessionRows,
    }, 200, origin);
  } catch (error) {
    console.error("student-portal unexpected error", error);
    return json({ error: "Unexpected server error." }, 500, origin);
  }
});
