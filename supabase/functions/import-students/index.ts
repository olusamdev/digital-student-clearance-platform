import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, isAllowedOrigin, rejectOrigin } from "./_shared/cors.ts";

type Json = Record<string, unknown>;
type InputRow = { registration_number?: unknown; full_name?: unknown; name?: unknown };
type Issue = { row: number; registration_number?: string; message: string };
type Prepared = { registration_number: string; full_name: string };
const json = (body: unknown, status = 200, origin = "") => new Response(JSON.stringify(body), {
  status, headers: { ...(origin ? corsHeaders(origin) : {}), "Content-Type": "application/json", "Cache-Control": "no-store" },
});
const clean = (value: unknown, max = 500) => typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0,max) : "";
const key = (value: unknown) => clean(value,200).toLocaleLowerCase().replace(/\s+/g," ");
const optional = (value: unknown, max: number) => clean(value,max) || null;
function yearValue(value: unknown): number | null | "invalid" {
  const valueText = clean(value,10);
  if (!valueText) return null;
  if (!/^\d{4}$/.test(valueText)) return "invalid";
  const year = Number(valueText);
  if (year < 1950 || year > new Date().getFullYear() + 10) return "invalid";
  return year;
}

async function prepareRows(admin: ReturnType<typeof createClient>, rawRows: unknown[]) {
  const issues: Issue[] = [];
  const prepared: Prepared[] = [];
  if (!Array.isArray(rawRows) || rawRows.length < 1) return { prepared, issues: [{ row: 0, message: "No student rows were supplied." }], valid_rows: 0, invalid_rows: 1, duplicate_rows: 0 };
  if (rawRows.length > 1000) return { prepared, issues: [{ row: 0, message: "Maximum 1,000 student records per import." }], valid_rows: 0, invalid_rows: rawRows.length, duplicate_rows: 0 };
  const seen = new Map<string, number>();
  rawRows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const row = raw && typeof raw === "object" ? raw as InputRow : {};
    const registration = clean(row.registration_number, 100).toUpperCase();
    const fullName = clean(row.full_name ?? row.name, 160).replace(/\s+/g, " ");
    const messages: string[] = [];
    if (!registration) messages.push("Registration number is required.");
    if (fullName.length < 2) messages.push("Name must contain at least 2 characters.");
    const previous = registration ? seen.get(registration) : undefined;
    if (previous !== undefined) messages.push(`Duplicate registration number in this file (first appears on row ${previous}).`);
    else if (registration) seen.set(registration, rowNumber);
    if (messages.length) { issues.push({ row: rowNumber, registration_number: registration || undefined, message: messages.join(" ") }); return; }
    prepared.push({ registration_number: registration, full_name: fullName });
  });
  const registrationNumbers = prepared.map((row) => row.registration_number);
  const existing = new Set<string>();
  for (let i = 0; i < registrationNumbers.length; i += 200) {
    const chunk = registrationNumbers.slice(i, i + 200);
    const { data, error } = await admin.from("student_records").select("registration_number").in("registration_number", chunk);
    if (error) throw new Error("Could not check existing registration numbers.");
    for (const record of data ?? []) existing.add(key(record.registration_number));
  }
  for (const row of prepared) {
    if (existing.has(key(row.registration_number))) {
      const rowIndex = rawRows.findIndex((r) => {
        const candidate = r && typeof r === "object" ? r as InputRow : {};
        return clean(candidate.registration_number, 100).toUpperCase() === row.registration_number;
      });
      issues.push({ row: rowIndex + 2, registration_number: row.registration_number, message: "Registration number already exists in the student register; existing records are never overwritten." });
    }
  }
  const duplicateRows = issues.filter((issue) => issue.message.toLowerCase().includes("duplicate registration") || issue.message.toLowerCase().includes("already exists")).length;
  const invalidRows = new Set(issues.map((issue) => issue.row)).size;
  return { prepared, issues, valid_rows: Math.max(0, rawRows.length - invalidRows), invalid_rows: invalidRows, duplicate_rows: duplicateRows };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  if (!isAllowedOrigin(origin)) return rejectOrigin(origin);
  if (req.method === "OPTIONS") return new Response(null,{status:204,headers:corsHeaders(origin)});
  if (req.method !== "POST") return json({error:"Method not allowed"},405,origin);
  try {
    const url=Deno.env.get("SUPABASE_URL"), anon=Deno.env.get("SUPABASE_ANON_KEY"), service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !anon || !service) return json({error:"Server configuration incomplete"},500,origin);
    const authorization=req.headers.get("Authorization");
    if (!authorization?.startsWith("Bearer ")) return json({error:"Authentication required"},401,origin);
    const client=createClient(url,anon,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
    const {data:userData,error:userError}=await client.auth.getUser();
    const actor=userData.user;
    if(userError||!actor) return json({error:"Invalid session"},401,origin);
    const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
    const [{data:profile,error:profileError},{data:roles,error:rolesError}]=await Promise.all([
      admin.from("staff_profiles").select("user_id").eq("user_id",actor.id).eq("active",true).maybeSingle(),
      admin.from("staff_role_assignments").select("role").eq("user_id",actor.id).eq("active",true),
    ]);
    if(profileError||rolesError) return json({error:"Could not verify staff permissions"},500,origin);
    if(!profile||!roles?.some((role)=>role.role==="superadmin")) return json({error:"SuperAdmin access required"},403,origin);

    const body=await req.json().catch(()=>({})) as Json;
    const action=String(body.action??"");
    if(action==="history") {
      const {data:history,error:historyError}=await admin.from("import_batches").select("id,original_filename,total_rows,inserted_rows,updated_rows,rejected_rows,status,created_at,completed_at").order("created_at",{ascending:false}).limit(20);
      if(historyError) return json({error:"Could not load student import history."},500,origin);
      return json({history:history??[]},200,origin);
    }
    const rows=body.rows;
    if(action!=="validate"&&action!=="import") return json({error:"Unsupported import action."},400,origin);
    if(!Array.isArray(rows)) return json({error:"Student rows must be supplied as an array."},400,origin);
    const checked=await prepareRows(admin,rows);
    if(action==="validate") return json({
      rows: rows.map((row,index)=>({row:index+2,...(row&&typeof row==="object"?row:{})})),
      valid_rows:checked.valid_rows,invalid_rows:checked.invalid_rows,duplicate_rows:checked.duplicate_rows,issues:checked.issues
    },200,origin);
    if(checked.issues.length) return json({error:"Validation failed. No student records were imported.",issues:checked.issues,valid_rows:checked.valid_rows,invalid_rows:checked.invalid_rows,duplicate_rows:checked.duplicate_rows},422,origin);

    const filename=clean(body.filename,255)||"student-import.csv";
    const {data:batch,error:batchError}=await admin.from("import_batches").insert({
      original_filename:filename,uploaded_by:actor.id,total_rows:rows.length,status:"validating",error_report:[]
    }).select("id").single();
    if(batchError||!batch) {
      console.error("student import batch creation failed",{code:batchError?.code,message:batchError?.message});
      return json({error:"Could not create the import audit record. No students were imported."},500,origin);
    }
    const now=new Date().toISOString();
    const insertRows=checked.prepared.map((row)=>({...row,college_uploaded:true,imported_batch_id:batch.id,imported_at:now,updated_at:now}));
    const {data:inserted,error:insertError}=await admin.from("student_records").insert(insertRows).select("id,registration_number");
    if(insertError||!inserted||inserted.length!==insertRows.length) {
      const message=insertError?.code==="23505"?"A registration number was added by another import after validation. No records from this batch were saved; validate again.":"The database rejected this batch. No student records were saved.";
      await admin.from("import_batches").update({status:"failed",rejected_rows:rows.length,error_report:[{row:0,message}],completed_at:now}).eq("id",batch.id);
      console.error("student import insert failed",{batch_id:batch.id,code:insertError?.code,message:insertError?.message});
      return json({error:message,batch_id:batch.id,total_rows:rows.length,inserted_rows:0,rejected_rows:rows.length,issues:[{row:0,message}]},409,origin);
    }
    const {error:updateBatchError}=await admin.from("import_batches").update({status:"imported",inserted_rows:inserted.length,updated_rows:0,rejected_rows:0,completed_at:now,error_report:[]}).eq("id",batch.id);
    await admin.from("audit_events").insert({actor_user_id:actor.id,event_type:"students.imported",entity_type:"import_batch",entity_id:batch.id,details:{filename,total_rows:rows.length,inserted_rows:inserted.length,registration_numbers:inserted.slice(0,100).map((r)=>r.registration_number)}});
    if(updateBatchError) console.error("student import batch status update failed",{batch_id:batch.id,code:updateBatchError.code});
    return json({success:true,batch_id:batch.id,total_rows:rows.length,inserted_rows:inserted.length,rejected_rows:0},200,origin);
  } catch(error) {
    console.error("import-students unexpected error",error);
    return json({error:error instanceof Error?error.message:"Unexpected server error."},500,origin);
  }
});
