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
    const fullName = clean(row.full_name ?? row.name, 160).replace(/\\s+/g, " ");
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
      issues.push({ row: rawRows.findIndex((r) => clean((r as InputRow)?.registration_number, 100).toUpperCase() === row.registration_number) + 2, registration_number: row.registration_number, message: "Registration number already exists in the student register; existing records are never overwritten." });
    }
  }
  const duplicateRows = issues.filter((issue) => issue.message.toLowerCase().includes("duplicate registration") || issue.message.toLowerCase().includes("already exists")).length;
  const invalidRows = new Set(issues.map((issue) => issue.row)).size;
  return { prepared, issues, valid_rows: Math.max(0, rawRows.length - invalidRows), invalid_rows: invalidRows, duplicate_rows: duplicateRows };
}

