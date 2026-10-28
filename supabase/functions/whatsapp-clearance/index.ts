import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GRAPH_VERSION = Deno.env.get("WHATSAPP_GRAPH_API_VERSION") ?? "v23.0";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(raw: string, signature: string | null, secret: string): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(signature.slice(7).toLowerCase(), hex);
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

type MetaSendResult = { messages?: Array<{ id?: string }>; error?: { message?: string; code?: number } };

async function sendMeta(to: string, message: Record<string, unknown>): Promise<{ ok: boolean; id?: string; error?: string }> {
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  const token = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!phoneNumberId || !token) return { ok: false, error: "WhatsApp API credentials are not configured" };
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...message }),
  });
  const result = await response.json().catch(() => ({})) as MetaSendResult;
  if (!response.ok) return { ok: false, error: result.error?.message ?? `WhatsApp API returned ${response.status}` };
  return { ok: true, id: result.messages?.[0]?.id };
}

async function sendText(to: string, body: string) {
  return sendMeta(to, { type: "text", text: { preview_url: false, body: body.slice(0, 4000) } });
}

async function sendRequestTemplate(to: string, request: {
  id: string; studentName: string; registrationNumber: string; officeName: string;
  department: string; programme: string; sessionName: string; instructions: string | null;
}) {
  const templateName = Deno.env.get("WHATSAPP_TEMPLATE_NAME");
  const language = Deno.env.get("WHATSAPP_TEMPLATE_LANGUAGE") ?? "en";
  if (!templateName) return { ok: false, error: "Approved WHATSAPP_TEMPLATE_NAME is not configured" };
  const parameters = [
    request.studentName, request.registrationNumber, request.officeName,
    request.department || "Not specified", request.programme || "Not specified",
    request.sessionName || "Current session", request.instructions || "No additional instructions",
  ].map((text) => ({ type: "text", text: String(text).slice(0, 900) }));
  const components: Record<string, unknown>[] = [
    { type: "body", parameters },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `clear:${request.id}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `comment:${request.id}` }] },
  ];
  return sendMeta(to, {
    type: "template",
    template: { name: templateName, language: { code: language }, components },
  });
}

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function writeMessageLog(input: {
  requestId?: string | null; recipientUserId?: string | null; direction: "inbound" | "outbound";
  eventType: string; phone: string; providerId?: string | null; status: string; payload?: unknown;
}) {
  return admin.from("whatsapp_messages").insert({
    clearance_request_id: input.requestId ?? null,
    recipient_user_id: input.recipientUserId ?? null,
    direction: input.direction,
    event_type: input.eventType,
    phone_number: input.phone,
    provider_message_id: input.providerId ?? null,
    delivery_status: input.status,
    payload: input.payload ?? {},
  }).select("id").maybeSingle();
}

async function updateMessageLog(id: string | undefined, status: string, providerId?: string) {
  if (!id) return;
  await admin.from("whatsapp_messages").update({
    delivery_status: status,
    ...(providerId ? { provider_message_id: providerId } : {}),
  }).eq("id", id);
}

async function dispatchSessionRequests(sessionStudentId: string) {
  const { data: link, error: linkError } = await admin.from("session_students")
    .select("id,student_id,session_id").eq("id", sessionStudentId).maybeSingle();
  if (linkError || !link) return json({ error: "Student session not found" }, 404);

  const [{ data: student }, { data: session }, { data: requests }] = await Promise.all([
    admin.from("student_records").select("id,full_name,registration_number,department_id,programme_id").eq("id", link.student_id).maybeSingle(),
    admin.from("clearance_sessions").select("name,academic_session").eq("id", link.session_id).maybeSingle(),
    admin.from("clearance_requests").select("id,requirement_id,status,requested_at").eq("session_student_id", sessionStudentId).in("status", ["requested", "needs_attention"]),
  ]);
  if (!student || !requests?.length) return json({ success: true, sent: 0, reason: "No actionable clearance requests" });

  const [{ data: department }, { data: programme }, { data: assignments }, { data: profileRows }] = await Promise.all([
    student.department_id ? admin.from("departments").select("id,name").eq("id", student.department_id).maybeSingle() : Promise.resolve({ data: null }),
    student.programme_id ? admin.from("programmes").select("id,name").eq("id", student.programme_id).maybeSingle() : Promise.resolve({ data: null }),
    admin.from("staff_role_assignments").select("user_id,role,office_id,department_id").eq("active", true),
    admin.from("staff_profiles").select("user_id,full_name,active,whatsapp_phone,whatsapp_enabled").eq("active", true).eq("whatsapp_enabled", true).not("whatsapp_phone", "is", null),
  ]);
  const profiles = new Map((profileRows ?? []).map((p) => [p.user_id, p]));
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of requests) {
    const { data: requirement } = await admin.from("clearance_requirements").select("id,office_id,instructions").eq("id", row.requirement_id).maybeSingle();
    if (!requirement) { skipped++; continue; }
    const { data: office } = await admin.from("clearance_offices").select("id,code,name").eq("id", requirement.office_id).maybeSingle();
    if (!office) { skipped++; continue; }

    const recipientIds = new Set((assignments ?? []).filter((a) => {
      if (a.role === "clearance_officer") return a.office_id === office.id && office.code !== "HOD";
      if (a.role === "head_of_department") return a.office_id === office.id && office.code === "HOD" && a.department_id === student.department_id;
      if (a.role === "bursar") return office.code === "BURSARY";
      if (a.role === "registrar") return office.code === "REG";
      return false;
    }).map((a) => a.user_id).filter((id) => profiles.has(id)));

    for (const userId of recipientIds) {
      const profile = profiles.get(userId);
      if (!profile?.whatsapp_phone) continue;
      const noticeEvent = `clearance_request:${String(row.requested_at ?? row.id)}`;
      const { data: existing } = await admin.from("whatsapp_messages").select("id,delivery_status")
        .eq("clearance_request_id", row.id).eq("recipient_user_id", userId)
        .eq("direction", "outbound").eq("event_type", noticeEvent).maybeSingle();
      if (existing && existing.delivery_status !== "failed") { skipped++; continue; }
      let logId = existing?.id as string | undefined;
      if (existing?.id) {
        await admin.from("whatsapp_messages").update({ delivery_status: "queued", phone_number: profile.whatsapp_phone })
          .eq("id", existing.id);
      } else {
        const { data: log, error: logError } = await writeMessageLog({
          requestId: row.id, recipientUserId: userId, direction: "outbound", eventType: noticeEvent,
          phone: profile.whatsapp_phone, status: "queued",
          payload: { office_code: office.code, student_id: student.id },
        });
        if (logError || !log?.id) { skipped++; continue; }
        logId = log.id;
      }
      if (!logId) { skipped++; continue; }

      const result = await sendRequestTemplate(profile.whatsapp_phone, {
        id: row.id, studentName: student.full_name, registrationNumber: student.registration_number,
        officeName: office.name, department: department?.name ?? "", programme: programme?.name ?? "",
        sessionName: session?.name ?? session?.academic_session ?? "Current session",
        instructions: requirement.instructions ?? null,
      });
      await updateMessageLog(logId, result.ok ? "sent" : "failed", result.id);
      if (result.ok) sent++;
      else errors.push(`${office.code}: ${result.error ?? "send failed"}`);
    }
  }
  return json({ success: true, sent, skipped, errors: errors.slice(0, 10) });
}

async function processButton(phone: string, requestId: string, action: "clear" | "comment") {
  const normalized = normalizePhone(phone);
  const { data: officer } = await admin.from("staff_profiles").select("user_id,full_name")
    .eq("whatsapp_phone", normalized).eq("whatsapp_enabled", true).eq("active", true).maybeSingle();
  if (!officer) {
    await sendText(phone, "This WhatsApp number is not enabled for a DSCP officer. Contact the SuperAdmin.");
    return;
  }

  if (action === "comment") {
    await admin.from("whatsapp_pending_comments").update({ consumed_at: new Date().toISOString() })
      .eq("recipient_user_id", officer.user_id).is("consumed_at", null);
    const { error } = await admin.from("whatsapp_pending_comments").insert({
      recipient_user_id: officer.user_id, clearance_request_id: requestId, phone_number: normalized,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    if (error) {
      await sendText(phone, "I could not open the comment prompt. Please try Comment again.");
      return;
    }
    await sendText(phone, "Please reply with your comment or reason for this clearance request within 15 minutes. Your message will be recorded in the DSCP audit trail.");
    return;
  }

  const { data, error } = await admin.rpc("process_whatsapp_clearance_action", {
    p_phone: normalized, p_request_id: requestId, p_action: "clear", p_comment_text: null,
  });
  if (error || !data?.success) {
    await sendText(phone, "DSCP could not clear this request. It may already have been processed, or your account may not be assigned to this request. Please check the staff portal.");
    return;
  }
  await sendText(phone, `Confirmed: clearance for ${data.student_name} (${data.registration_number}) from ${data.office_name} has been marked CLEARED in DSCP.`);
  await notifyProvostIfReady(String(data.session_student_id), String(data.request_id));
}

async function processComment(phone: string, messageText: string) {
  const normalized = normalizePhone(phone);
  const { data: pending } = await admin.from("whatsapp_pending_comments").select("id,recipient_user_id,clearance_request_id")
    .eq("phone_number", normalized).is("consumed_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!pending) {
    await sendText(phone, "No active comment request was found. Open the latest DSCP clearance notification and choose Comment.");
    return;
  }
  const { data, error } = await admin.rpc("process_whatsapp_clearance_action", {
    p_phone: normalized, p_request_id: pending.clearance_request_id, p_action: "comment", p_comment_text: messageText,
  });
  if (error || !data?.success) {
    await sendText(phone, "DSCP could not save this comment. The request may no longer be actionable, or your account may not be assigned to it. Please check the staff portal.");
    return;
  }
  await admin.from("whatsapp_pending_comments").update({ consumed_at: new Date().toISOString() }).eq("id", pending.id);
  await sendText(phone, `Your comment for ${data.student_name} (${data.registration_number}) — ${data.office_name} — has been recorded in DSCP.`);
}

async function notifyProvostIfReady(sessionStudentId: string, requestId: string) {
  const { data: link } = await admin.from("session_students").select("id,session_id,student_id").eq("id", sessionStudentId).maybeSingle();
  if (!link) return;
  const [{ data: student }, { data: requirements }, { data: requests }] = await Promise.all([
    admin.from("student_records").select("full_name,registration_number,department_id,programme_id").eq("id", link.student_id).maybeSingle(),
    admin.from("clearance_requirements").select("id,session_id,department_id,programme_id,enabled,required").eq("session_id", link.session_id).eq("enabled", true).eq("required", true),
    admin.from("clearance_requests").select("requirement_id,status").eq("session_student_id", sessionStudentId),
  ]);
  if (!student || !requirements?.length) return;
  const applicable = requirements.filter((r) => (!r.department_id || r.department_id === student.department_id) && (!r.programme_id || r.programme_id === student.programme_id));
  if (!applicable.length || !applicable.every((r) => requests?.some((cr) => cr.requirement_id === r.id && cr.status === "cleared"))) return;

  const { data: provostRoles } = await admin.from("staff_role_assignments").select("user_id").eq("role", "provost").eq("active", true);
  const ids = [...new Set((provostRoles ?? []).map((r) => r.user_id))];
  if (!ids.length) return;
  const { data: provosts } = await admin.from("staff_profiles").select("user_id,whatsapp_phone")
    .in("user_id", ids).eq("active", true).eq("whatsapp_enabled", true).not("whatsapp_phone", "is", null);
  for (const provost of provosts ?? []) {
    const { data: prior } = await admin.from("whatsapp_messages").select("id")
      .eq("recipient_user_id", provost.user_id).eq("event_type", "provost_ready")
      .eq("clearance_request_id", requestId).maybeSingle();
    if (prior || !provost.whatsapp_phone) continue;
    const { data: log } = await writeMessageLog({
      requestId, recipientUserId: provost.user_id, direction: "outbound", eventType: "provost_ready",
      phone: provost.whatsapp_phone, status: "queued",
    });
    if (!log?.id) continue;
    const result = await sendText(provost.whatsapp_phone,
      `DSCP update: all required office clearances are complete for ${student.full_name} (${student.registration_number}). Final Assent is now ready in the Provost portal.`);
    await updateMessageLog(log.id, result.ok ? "sent" : "failed", result.id);
  }
}

Deno.serve(async (req: Request) => {
  const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";

  if (req.method === "GET") {
    const url = new URL(req.url);
    if (url.searchParams.get("hub.mode") === "subscribe"
      && verifyToken
      && url.searchParams.get("hub.verify_token") === verifyToken) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }
  const body = payload as Record<string, unknown>;

  // Internal server-to-server dispatch from student-portal is authenticated with the
  // service-role key. It does not originate from Meta and therefore has no Meta signature.
  if (body.action === "dispatch_student_requests") {
    const auth = req.headers.get("authorization") ?? "";
    if (!serviceKey || auth !== `Bearer ${serviceKey}`) return json({ error: "Unauthorized" }, 401);
    return await dispatchSessionRequests(String(body.session_student_id ?? ""));
  }

  const signature = req.headers.get("x-hub-signature-256");
  if (!appSecret || !(await verifySignature(raw, signature, appSecret))) {
    return json({ error: "Invalid webhook signature" }, 401);
  }

  const entries = Array.isArray(body.entry) ? body.entry as Array<Record<string, unknown>> : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes as Array<Record<string, unknown>> : [];
    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      const messages = Array.isArray(value?.messages) ? value.messages as Array<Record<string, unknown>> : [];
      for (const message of messages) {
        const from = String(message.from ?? "");
        const messageId = String(message.id ?? "");
        if (!from || !messageId) continue;
        const inserted = await writeMessageLog({
          direction: "inbound", eventType: "incoming", phone: normalizePhone(from),
          providerId: messageId, status: "received", payload: { type: message.type ?? "unknown" },
        });
        let inboundLogId = inserted.data?.id as string | undefined;
        if (inserted.error?.code === "23505") {
          const { data: prior } = await admin.from("whatsapp_messages").select("id,delivery_status")
            .eq("provider_message_id", messageId).maybeSingle();
          if (!prior || prior.delivery_status === "processed") continue;
          inboundLogId = prior.id;
        } else if (inserted.error || !inboundLogId) {
          continue;
        }

        try {
          const interactive = message.interactive as Record<string, unknown> | undefined;
          const buttonReply = interactive?.button_reply as Record<string, unknown> | undefined;
          const replyId = String(buttonReply?.id ?? "");
          const match = /^(clear|comment):([0-9a-f-]{36})$/i.exec(replyId);
          if (match) {
            await processButton(from, match[2], match[1].toLowerCase() as "clear" | "comment");
          } else if (message.type === "text") {
            const textBody = String((message.text as Record<string, unknown> | undefined)?.body ?? "").trim();
            if (textBody) await processComment(from, textBody);
          }
          await updateMessageLog(inboundLogId, "processed");
        } catch (messageError) {
          await updateMessageLog(inboundLogId, "failed");
          console.error("WhatsApp inbound message processing failed", messageError);
        }
      }
    }
  }
  return json({ success: true });
});
