import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type StudentImportRow = {
  registration_number: string;
  full_name: string;
  department: string;
  programme: string;
  phone_number?: string;
  gender?: string;
  student_set?: string;
  admission_year?: string | number;
  graduation_year?: string | number;
  permanent_address?: string;
};
type RowIssue = { row: number; registration_number?: string; message: string };
type PreviewResult = { valid_rows: number; invalid_rows: number; duplicate_rows: number; rows: StudentImportRow[]; issues: RowIssue[] };
type ImportResult = { success: boolean; batch_id?: string; total_rows: number; inserted_rows: number; rejected_rows: number; issues?: RowIssue[] };
type ImportBatch = { id: string; original_filename: string; total_rows: number; inserted_rows: number; updated_rows: number; rejected_rows: number; status: string; created_at: string; completed_at: string | null };

const HEADERS = ['registration_number','full_name','department','programme','phone_number','gender','student_set','admission_year','graduation_year','permanent_address'];
const TEMPLATE = [
  HEADERS.join(','),
  'COHT/2026/001,"Amina Musa",CHS,DCH,08012345678,Female,2022/2023,2022,2026,"Takum, Taraba State"',
  'COHT/2026/002,"John James",CHS,CCH,08087654321,Male,2022/2023,2022,2026,"Takum, Taraba State"',
].join('\r\n');

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const input = source.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field.trim()); field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new Error('CSV contains an unclosed quoted cell. Open the file in Excel and save it as CSV UTF-8, then try again.');
  row.push(field.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

function readCsv(source: string): StudentImportRow[] {
  const parsed = parseCsv(source);
  if (parsed.length < 2) throw new Error('The CSV must contain a header row and at least one student row.');
  const header = parsed[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const missing = ['registration_number','full_name','department','programme'].filter((h) => !header.includes(h));
  if (missing.length) throw new Error(`Missing required column(s): ${missing.join(', ')}. Download the template for the exact column names.`);
  if (header.length !== new Set(header).size) throw new Error('The CSV contains duplicate column headings. Correct the header row and retry.');
  return parsed.slice(1).map((cells) => {
    const obj: Record<string,string> = {};
    header.forEach((name, index) => { obj[name] = (cells[index] ?? '').trim(); });
    return {
      registration_number: obj.registration_number ?? '',
      full_name: obj.full_name ?? '',
      department: obj.department ?? '',
      programme: obj.programme ?? '',
      phone_number: obj.phone_number ?? '',
      gender: obj.gender ?? '',
      student_set: obj.student_set ?? '',
      admission_year: obj.admission_year ?? '',
      graduation_year: obj.graduation_year ?? '',
      permanent_address: obj.permanent_address ?? '',
    };
  });
}

function downloadTemplate() {
  const blob = new Blob([TEMPLATE], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'COHT-student-import-template.csv'; anchor.click();
  URL.revokeObjectURL(url);
}

export default function StudentImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<StudentImportRow[]>([]);
  const [issues, setIssues] = useState<RowIssue[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [history, setHistory] = useState<ImportBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const canImport = useMemo(() => Boolean(preview && preview.invalid_rows === 0 && preview.duplicate_rows === 0 && rows.length > 0 && !busy), [preview, rows.length, busy]);

  const loadHistory = async () => {
    const { data, error: invokeError } = await supabase.functions.invoke('import-students', { body: { action: 'history' } });
    if (!invokeError && Array.isArray(data?.history)) setHistory(data.history as ImportBatch[]);
  };
  useEffect(() => { void loadHistory(); }, []);


  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name); setRows([]); setIssues([]); setPreview(null); setResult(null); setError(''); setNotice('');
    if (!file.name.toLowerCase().endsWith('.csv')) { setError('Please upload a .csv file. Open Excel files and save them as CSV UTF-8 first.'); return; }
    if (file.size > 5 * 1024 * 1024) { setError('File exceeds 5 MB. Split the student list into smaller CSV files.'); return; }
    try {
      const parsed = readCsv(await file.text());
      if (parsed.length > 1000) throw new Error('Maximum 1,000 students per import. Split the file and import in batches.');
      setRows(parsed);
      setNotice(`Read ${parsed.length.toLocaleString()} student row(s). Run server validation before importing.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read this CSV.'); }
  }

  async function validateRows() {
    if (!rows.length) return;
    setBusy(true); setError(''); setNotice(''); setPreview(null); setIssues([]); setResult(null);
    const { data, error: invokeError } = await supabase.functions.invoke('import-students', { body: { action: 'validate', filename: fileName, rows } });
    setBusy(false);
    if (invokeError || data?.error) { setError(invokeError ? await describeFunctionError(invokeError, 'import-students', 'Could not validate the student import.') : String(data.error)); return; }
    setPreview(data as PreviewResult);
    setIssues((data.issues ?? []) as RowIssue[]);
    setNotice(data.invalid_rows === 0 && data.duplicate_rows === 0 ? 'Validation passed. Review the summary before importing.' : 'Fix every reported issue in the source file, then upload it again.');
  }

  async function importRows() {
    if (!canImport || !window.confirm(`Import ${rows.length.toLocaleString()} student records from “${fileName}”? Existing registration numbers will not be overwritten.`)) return;
    setBusy(true); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('import-students', { body: { action: 'import', filename: fileName, rows } });
    setBusy(false);
    if (invokeError || data?.error) { setError(invokeError ? await describeFunctionError(invokeError, 'import-students', 'Student import failed.') : String(data.error)); return; }
    const imported = data as ImportResult;
    setResult(imported); setIssues((imported.issues ?? []) as RowIssue[]);
    await loadHistory();
    setNotice(imported.success ? `Successfully imported ${imported.inserted_rows.toLocaleString()} student record(s).` : 'Import did not complete. Review the error report before retrying.');
    if (imported.success) { setRows([]); setPreview(null); setFileName(''); if (inputRef.current) inputRef.current.value = ''; }
  }

  return <section className="management-section">
    <div className="section-title"><div><p className="eyebrow dark">STUDENT RECORDS</p><h2>Import student records</h2><p className="muted">Upload the college-approved final-year student list. Validate first; nothing is saved until you confirm the import.</p></div><button className="secondary-button" type="button" onClick={downloadTemplate}>Download CSV template</button></div>
    <div className="management-grid">
      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow dark">STEP 1</p><h2>Choose student list</h2></div></div>
        <div className="management-form">
          <label htmlFor="student-import-file">Student list (.csv)</label>
          <input ref={inputRef} id="student-import-file" type="file" accept=".csv,text/csv" onChange={(e) => void chooseFile(e)} disabled={busy} />
          {fileName && <p className="field-note">Selected: <strong>{fileName}</strong> · {rows.length.toLocaleString()} row(s) loaded</p>}
          <button className="secondary-button" type="button" onClick={() => void validateRows()} disabled={!rows.length || busy}>{busy ? 'Please wait…' : 'Validate records'}</button>
          <p className="field-note">CSV UTF-8 only · Maximum 1,000 rows and 5 MB per import. Fields containing commas must be quoted. The parser supports quoted commas, quotes and line breaks.</p>
        </div>
      </article>
      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow dark">STEP 2</p><h2>Validation summary</h2></div></div>
        {!preview ? <p className="muted">Select a file and run validation to check required fields, department/programme matches, duplicate registration numbers, and existing records.</p> : <><div className="clearance-meta"><span><strong>Total rows</strong>{preview.rows.length}</span><span><strong>Valid rows</strong>{preview.valid_rows}</span><span><strong>Invalid rows</strong>{preview.invalid_rows}</span><span><strong>Duplicates</strong>{preview.duplicate_rows}</span></div><p className="field-note">Import is enabled only when all rows pass validation. Existing student records are never silently overwritten.</p><button className="primary-button" type="button" disabled={!canImport} onClick={() => void importRows()}>{busy ? 'Importing…' : `Import ${rows.length.toLocaleString()} records`}</button></>}
      </article>
    </div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    {issues.length > 0 && <article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">VALIDATION REPORT</p><h2>{issues.length} issue(s) found</h2></div></div><div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>CSV row</th><th>Registration number</th><th>Issue</th></tr></thead><tbody>{issues.slice(0,100).map((issue,i) => <tr key={`${issue.row}-${i}`}><td>{issue.row}</td><td>{issue.registration_number || '—'}</td><td>{issue.message}</td></tr>)}</tbody></table></div>{issues.length > 100 && <p className="field-note">Showing first 100 of {issues.length} issues.</p>}</article>}
    {result && <article className="panel"><p className="eyebrow dark">IMPORT RESULT</p><h2>{result.success ? 'Import complete' : 'Import failed'}</h2><div className="clearance-meta"><span><strong>Total rows</strong>{result.total_rows}</span><span><strong>Inserted</strong>{result.inserted_rows}</span><span><strong>Rejected</strong>{result.rejected_rows}</span><span><strong>Batch reference</strong>{result.batch_id ? result.batch_id.slice(0,8) : '—'}</span></div></article>}
    <article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">AUDITABLE IMPORTS</p><h2>Recent import history</h2></div><button className="secondary-button" type="button" onClick={() => void loadHistory()}>Refresh history</button></div>{history.length===0?<p className="muted">No student import batches have been recorded yet.</p>:<div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>File / date</th><th>Rows</th><th>Inserted</th><th>Rejected</th><th>Status</th></tr></thead><tbody>{history.map((batch)=><tr key={batch.id}><td><strong>{batch.original_filename}</strong><small>{new Date(batch.created_at).toLocaleString()} · {batch.id.slice(0,8)}</small></td><td>{batch.total_rows}</td><td>{batch.inserted_rows}</td><td>{batch.rejected_rows}</td><td><span className={"directory-status " + (batch.status==="imported"?"active":batch.status==="failed"?"inactive":"invited")}>{batch.status}</span></td></tr>)}</tbody></table></div>}</article>
    <p className="dashboard-footnote">Import requires an active SuperAdmin session. Every batch is recorded in the import history and audit log.</p>
  </section>;
}
