import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "../_shared/cors.ts";

const BUCKET = "bursary-receipts";
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
type Obj = Record<string, unknown>;

const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const text = (v: unknown, max = 200) => typeof v === "string" ? v.trim().slice(0, max) : "";

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
    const authorization = req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, origin);

    const userClient = createClient(url, anon, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return json({ error: "Invalid session" }, 401, origin);

    const body = await req.json().catch(() => ({})) as Obj;
    const action = text(body.action, 60);
    const payload = body.payload && typeof body.payload === "object" ? body.payload as Obj : {};
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const userId = authData.user.id;

    const isBursar = async () => {
      const { data, error } = await admin.from("staff_profiles").select("user_id")
        .eq("user_id", userId).eq("active", true).maybeSingle();
      if (error || !data) return false;
      const { data: role, error: roleError } = await admin.from("staff_role_assignments")
        .select("id").eq("user_id", userId).eq("active", true).eq("role", "bursar").limit(1).maybeSingle();
      return !roleError && Boolean(role);
    };
    const getStudent = async () => {
      const { data, error } = await admin.from("student_records")
        .select("id,registration_number,full_name,department_id,programme_id")
        .eq("auth_user_id", userId).maybeSingle();
      if (error) throw new Error("Could not verify the student account.");
      if (!data) throw new Error("An active student account is required.");
      return data;
    };
    const bursaryOfficeIds = async () => {
      const { data, error } = await admin.from("clearance_offices").select("id,code,name").eq("active", true);
      if (error) throw new Error("Could not verify the Bursary office.");
      return (data ?? []).filter((office) =>
        String(office.code ?? "").toLowerCase() === "bur" ||
        /bursar|bursary/i.test(String(office.name ?? ""))
      ).map((office) => office.id as string);
    };

    if (action === "create_upload" || action === "list_student_receipts" || action === "complete_upload") {
      const student = await getStudent();
      const sessionStudentId = text(payload.session_student_id, 80);
      if (!sessionStudentId) return json({ error: "Clearance session is required." }, 400, origin);
      const { data: link, error: linkError } = await admin.from("session_students")
        .select("id,session_id,student_id").eq("id", sessionStudentId).eq("student_id", student.id).maybeSingle();
      if (linkError || !link) return json({ error: "Clearance session not found for this student." }, 404, origin);

      if (action === "list_student_receipts") {
        const { data, error } = await admin.from("bursary_receipts")
          .select("id,original_filename,mime_type,size_bytes,uploaded_at,clearance_request_id")
          .eq("session_student_id", sessionStudentId).eq("uploaded_by_student_id", student.id)
          .not("uploaded_at", "is", null).order("created_at", { ascending: false });
        if (error) return json({ error: "Could not load your submitted receipts." }, 500, origin);
        return json({ receipts: data ?? [] }, 200, origin);
      }

      const officeIds = await bursaryOfficeIds();
      if (!officeIds.length) return json({ error: "The college has not configured a Bursary clearance office." }, 409, origin);
      const { data: requirements, error: requirementsError } = await admin.from("clearance_requirements")
        .select("id").eq("session_id", link.session_id).in("office_id", officeIds);
      if (requirementsError) return json({ error: "Could not verify the Bursary requirement." }, 500, origin);
      const requirementIds = (requirements ?? []).map((r) => r.id);
      if (!requirementIds.length) return json({ error: "No Bursary requirement is configured for this clearance session." }, 409, origin);
      const { data: requests, error: requestError } = await admin.from("clearance_requests")
        .select("id,requirement_id,status").eq("session_student_id", sessionStudentId).in("requirement_id", requirementIds);
      if (requestError) return json({ error: "Could not verify the Bursary clearance request." }, 500, origin);
      const requestedId = text(payload.clearance_request_id, 80);
      const request = requestedId ? (requests ?? []).find((r) => r.id === requestedId) : (requests ?? [])[0];
      if (!request) return json({ error: "Submit your clearance requests before uploading the Bursary receipt." }, 409, origin);
      if (request.status === "cleared") return json({ error: "This Bursary request has already been cleared. Contact the Bursar if a correction is needed." }, 409, origin);

      if (action === "create_upload") {
        const filename = text(payload.filename, 180).replace(/[\/\\\u0000-\u001f]/g, "_") || "receipt";
        const mimeType = text(payload.mime_type, 100).toLowerCase();
        const sizeBytes = Number(payload.size_bytes);
        if (!ALLOWED_TYPES.has(mimeType)) return json({ error: "Upload a PDF, JPG, PNG, or WebP receipt." }, 400, origin);
        if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BYTES) return json({ error: "Receipt files must be 5 MB or smaller." }, 400, origin);
        const path = `${student.id}/${sessionStudentId}/${crypto.randomUUID()}`;
        const { data: signed, error: signedError } = await admin.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: false });
        if (signedError || !signed) {
          console.error("bursary receipt upload URL failed", signedError?.message);
          return json({ error: "Could not prepare a secure receipt upload. Please try again." }, 500, origin);
        }
        const { data: receipt, error: insertError } = await admin.from("bursary_receipts").insert({
          session_student_id: sessionStudentId, clearance_request_id: request.id,
          uploaded_by_student_id: student.id, storage_path: path,
          original_filename: filename, mime_type: mimeType, size_bytes: sizeBytes,
        }).select("id").single();
        if (insertError || !receipt) {
          await admin.storage.from(BUCKET).remove([path]);
          return json({ error: "Could not register the receipt upload. Please try again." }, 500, origin);
        }
        return json({ receipt_id: receipt.id, path, token: signed.token }, 200, origin);
      }

      const receiptId = text(payload.receipt_id, 80);
      const { data: receipt, error: receiptError } = await admin.from("bursary_receipts")
        .select("id,storage_path,uploaded_by_student_id,session_student_id")
        .eq("id", receiptId).eq("session_student_id", sessionStudentId)
        .eq("clearance_request_id", request.id)
        .eq("uploaded_by_student_id", student.id).maybeSingle();
      if (receiptError || !receipt) return json({ error: "Receipt upload not found." }, 404, origin);
      const { data: signedCheck, error: checkError } = await admin.storage.from(BUCKET).createSignedUrl(receipt.storage_path, 60);
      if (checkError || !signedCheck?.signedUrl) return json({ error: "The receipt file was not uploaded successfully. Please retry the upload." }, 400, origin);
      const { error: updateError } = await admin.from("bursary_receipts").update({ uploaded_at: new Date().toISOString() })
        .eq("id", receipt.id).is("uploaded_at", null);
      if (updateError) return json({ error: "The receipt was uploaded but could not be submitted for review. Contact support." }, 500, origin);
      return json({ success: true }, 200, origin);
    }

    if (action === "list_bursar_receipts" || action === "download_receipt") {
      if (!await isBursar()) return json({ error: "Bursar access is required to view payment receipts." }, 403, origin);
      if (action === "download_receipt") {
        const receiptId = text(payload.receipt_id, 80);
        const { data: receipt, error } = await admin.from("bursary_receipts")
          .select("storage_path,original_filename").eq("id", receiptId).not("uploaded_at", "is", null).maybeSingle();
        if (error || !receipt) return json({ error: "Receipt not found." }, 404, origin);
        const { data: signed, error: signError } = await admin.storage.from(BUCKET)
          .createSignedUrl(receipt.storage_path, 60, { download: receipt.original_filename });
        if (signError || !signed?.signedUrl) return json({ error: "Could not open this receipt." }, 500, origin);
        return json({ url: signed.signedUrl }, 200, origin);
      }

      const officeIds = await bursaryOfficeIds();
      if (!officeIds.length) return json({ receipts: [] }, 200, origin);
      const { data: requirements, error: reqError } = await admin.from("clearance_requirements")
        .select("id,office_id").in("office_id", officeIds);
      if (reqError) return json({ error: "Could not load Bursary requirements." }, 500, origin);
      const requirementIds = (requirements ?? []).map((r) => r.id);
      if (!requirementIds.length) return json({ receipts: [] }, 200, origin);
      const { data: requests, error: requestsError } = await admin.from("clearance_requests")
        .select("id,session_student_id,requirement_id,status,requested_at").in("requirement_id", requirementIds);
      if (requestsError) return json({ error: "Could not load Bursary requests." }, 500, origin);
      const validRequests = (requests ?? []).filter((r) => r.status !== "not_requested");
      if (!validRequests.length) return json({ receipts: [] }, 200, origin);
      const requestById = new Map(validRequests.map((r) => [r.id, r]));
      const { data: receiptRows, error: receiptsError } = await admin.from("bursary_receipts")
        .select("id,session_student_id,clearance_request_id,original_filename,mime_type,size_bytes,uploaded_at")
        .in("clearance_request_id", [...requestById.keys()]).not("uploaded_at", "is", null).order("uploaded_at", { ascending: false });
      if (receiptsError) return json({ error: "Could not load uploaded receipts." }, 500, origin);
      const rows = receiptRows ?? [];
      if (!rows.length) return json({ receipts: [] }, 200, origin);
      const sessionStudentIds = [...new Set(rows.map((r) => r.session_student_id))];
      const { data: links, error: linksError } = await admin.from("session_students")
        .select("id,session_id,student_id").in("id", sessionStudentIds);
      if (linksError) return json({ error: "Could not load receipt student records." }, 500, origin);
      const linksById = new Map((links ?? []).map((l) => [l.id, l]));
      const studentIds = [...new Set((links ?? []).map((l) => l.student_id))];
      const sessionIds = [...new Set((links ?? []).map((l) => l.session_id))];
      const [{ data: students, error: studentsError }, { data: sessions, error: sessionsError }] = await Promise.all([
        admin.from("student_records").select("id,full_name,registration_number,department_id,programme_id").in("id", studentIds),
        admin.from("clearance_sessions").select("id,name,academic_session").in("id", sessionIds),
      ]);
      if (studentsError || sessionsError) return json({ error: "Could not load receipt details." }, 500, origin);
      const departmentIds = [...new Set((students ?? []).map((s) => s.department_id).filter(Boolean))] as string[];
      const programmeIds = [...new Set((students ?? []).map((s) => s.programme_id).filter(Boolean))] as string[];
      const [{ data: departments }, { data: programmes }] = await Promise.all([
        departmentIds.length ? admin.from("departments").select("id,name").in("id", departmentIds) : Promise.resolve({ data: [] }),
        programmeIds.length ? admin.from("programmes").select("id,name").in("id", programmeIds) : Promise.resolve({ data: [] }),
      ]);
      const { data: officeRequirements } = await admin.from("clearance_requirements").select("id,office_id").in("id", requirementIds);
      const officeIdsByRequirement = new Map((officeRequirements ?? []).map((r) => [r.id, r.office_id]));
      const officeNames = await admin.from("clearance_offices").select("id,name,code").in("id", officeIds);
      const officeById = new Map((officeNames.data ?? []).map((o) => [o.id, o]));
      const studentById = new Map((students ?? []).map((s) => [s.id, s]));
      const sessionById = new Map((sessions ?? []).map((s) => [s.id, s]));
      const departmentById = new Map((departments ?? []).map((d) => [d.id, d.name]));
      const programmeById = new Map((programmes ?? []).map((p) => [p.id, p.name]));
      return json({ receipts: rows.map((r) => {
        const link = linksById.get(r.session_student_id);
        const student = link ? studentById.get(link.student_id) : null;
        const clearanceSession = link ? sessionById.get(link.session_id) : null;
        const request = requestById.get(r.clearance_request_id);
        const office = request ? officeById.get(officeIdsByRequirement.get(request.requirement_id)) : null;
        return {
          id: r.id, session_student_id: r.session_student_id, clearance_request_id: r.clearance_request_id,
          original_filename: r.original_filename, mime_type: r.mime_type, size_bytes: r.size_bytes, uploaded_at: r.uploaded_at,
          student_name: student?.full_name ?? "Student", registration_number: student?.registration_number ?? "",
          department: student?.department_id ? departmentById.get(student.department_id) ?? null : null,
          programme: student?.programme_id ? programmeById.get(student.programme_id) ?? null : null,
          session_name: clearanceSession?.name ?? "Clearance session",
          academic_session: clearanceSession?.academic_session ?? null,
          office_name: office?.name ?? "Bursary",
          request_status: request?.status ?? "requested",
        };
      }) }, 200, origin);
    }

    return json({ error: "Unsupported receipt action." }, 400, origin);
  } catch (error) {
    console.error("bursary-receipts unexpected error", error);
    return json({ error: error instanceof Error ? error.message : "Unexpected server error." }, 500, origin);
  }
});
