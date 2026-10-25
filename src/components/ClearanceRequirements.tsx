import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type SessionRow = { id: string; name: string; academic_session: string; active: boolean };
type OfficeRow = { id: string; name: string; code: string; active: boolean; display_order: number };
type DepartmentRow = { id: string; name: string; code: string; active: boolean };
type ProgrammeRow = { id: string; name: string; code: string; department_id: string; active: boolean };
type Requirement = {
  id: string; session_id: string; session_name: string; academic_session: string;
  office_id: string; office_name: string; department_id: string | null; department_name: string | null;
  programme_id: string | null; programme_name: string | null; required: boolean; enabled: boolean;
  instructions: string | null; display_order: number;
};

export default function ClearanceRequirements() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [offices, setOffices] = useState<OfficeRow[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [programmes, setProgrammes] = useState<ProgrammeRow[]>([]);
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [officeId, setOfficeId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [programmeId, setProgrammeId] = useState('');
  const [required, setRequired] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [displayOrder, setDisplayOrder] = useState('100');

  const reload = useCallback(async () => {
    setLoading(true); setError('');
    const [s, o, d, p, r] = await Promise.all([
      supabase.from('clearance_sessions').select('id,name,academic_session,active').order('created_at', { ascending: false }),
      supabase.from('clearance_offices').select('id,name,code,active,display_order').order('display_order').order('name'),
      supabase.from('departments').select('id,name,code,active').order('name'),
      supabase.from('programmes').select('id,name,code,department_id,active').order('name'),
      supabase.functions.invoke('manage-clearance-requirements', { body: { action: 'list', payload: {} } }),
    ]);
    const loadError = s.error || o.error || d.error || p.error;
    if (loadError) setError('Could not load setup options: ' + loadError.message);
    else { setSessions((s.data ?? []) as SessionRow[]); setOffices((o.data ?? []) as OfficeRow[]); setDepartments((d.data ?? []) as DepartmentRow[]); setProgrammes((p.data ?? []) as ProgrammeRow[]); }
    if (r.error || r.data?.error || !r.data?.success) {
      setError(r.error ? await describeFunctionError(r.error, 'manage-clearance-requirements', 'Could not load clearance requirements.') : String(r.data?.error || 'Could not load clearance requirements.'));
      setRequirements([]);
    } else setRequirements((r.data.requirements ?? []) as Requirement[]);
    setLoading(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const activeProgrammes = useMemo(() => programmes.filter(x => x.active && (!departmentId || x.department_id === departmentId)), [programmes, departmentId]);
  function reset() {
    setEditingId(''); setSessionId(''); setOfficeId(''); setDepartmentId(''); setProgrammeId('');
    setRequired(true); setEnabled(false); setInstructions(''); setDisplayOrder('100');
  }
  function edit(item: Requirement) {
    setEditingId(item.id); setSessionId(item.session_id); setOfficeId(item.office_id);
    setDepartmentId(item.department_id ?? ''); setProgrammeId(item.programme_id ?? '');
    setRequired(item.required); setEnabled(item.enabled); setInstructions(item.instructions ?? '');
    setDisplayOrder(String(item.display_order));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('manage-clearance-requirements', {
      body: { action: 'save', payload: {
        id: editingId || null, session_id: sessionId, office_id: officeId,
        department_id: departmentId || null, programme_id: programmeId || null,
        required, enabled, instructions, display_order: displayOrder,
      } },
    });
    setSaving(false);
    if (invokeError || data?.error || !data?.success) {
      setError(invokeError ? await describeFunctionError(invokeError, 'manage-clearance-requirements', 'Could not save requirement.') : String(data?.error || 'Could not save requirement.'));
      return;
    }
    setNotice(enabled ? 'Requirement saved and enabled.' : 'Requirement saved as disabled. Students will not be asked to complete it until enabled.');
    reset(); await reload();
  }
  async function toggle(item: Requirement) {
    setSaving(true); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('manage-clearance-requirements', {
      body: { action: 'toggle', payload: { id: item.id, enabled: !item.enabled } },
    });
    setSaving(false);
    if (invokeError || data?.error || !data?.success) {
      setError(invokeError ? await describeFunctionError(invokeError, 'manage-clearance-requirements', 'Could not change requirement status.') : String(data?.error || 'Could not change requirement status.'));
      return;
    }
    setNotice(`Requirement ${item.enabled ? 'disabled' : 'enabled'}.`); await reload();
  }

  return <section className="institutional-setup">
    <div className="section-title"><div><p className="eyebrow dark">SUPERALMINISTRATOR ONLY</p><h2>Clearance requirements</h2><p className="muted">Configure the offices and requirements students must complete for each academic session. New requirements are disabled until you enable them.</p></div><button className="secondary-button" type="button" onClick={() => void reload()} disabled={loading || saving}>Refresh records</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
    <div className="management-grid setup-grid">
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">{editingId ? 'EDIT REQUIREMENT' : 'NEW REQUIREMENT'}</p><h2>{editingId ? 'Edit requirement' : 'Add requirement'}</h2></div></div>
        <form className="management-form" onSubmit={event => void submit(event)}>
          <label htmlFor="req-session">Academic session</label><select id="req-session" value={sessionId} onChange={e => setSessionId(e.target.value)} required><option value="">Select session</option>{sessions.map(x => <option key={x.id} value={x.id}>{x.name} ({x.academic_session}){x.active ? ' · Active' : ''}</option>)}</select>
          <label htmlFor="req-office">Clearance office</label><select id="req-office" value={officeId} onChange={e => setOfficeId(e.target.value)} required><option value="">Select active office</option>{offices.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
          <label htmlFor="req-department">Department scope (optional)</label><select id="req-department" value={departmentId} onChange={e => { setDepartmentId(e.target.value); setProgrammeId(''); }}><option value="">All departments</option>{departments.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
          <label htmlFor="req-programme">Programme scope (optional)</label><select id="req-programme" value={programmeId} onChange={e => setProgrammeId(e.target.value)} disabled={!departmentId}><option value="">All programmes in selected scope</option>{activeProgrammes.map(x => <option key={x.id} value={x.id}>{x.name} ({x.code})</option>)}</select>
          <label htmlFor="req-instructions">Instructions (optional)</label><textarea id="req-instructions" value={instructions} onChange={e => setInstructions(e.target.value)} rows={3} maxLength={2000} placeholder="What should the student do or provide?"/>
          <label htmlFor="req-order">Display order</label><input id="req-order" type="number" min={0} max={10000} value={displayOrder} onChange={e => setDisplayOrder(e.target.value)} required/>
          <label className="checkbox-label"><input type="checkbox" checked={required} onChange={e => setRequired(e.target.checked)}/> Mandatory requirement</label>
          <label className="checkbox-label"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}/> Enabled for students</label>
          <button className="primary-button" type="submit" disabled={saving || loading || !sessions.length || !offices.some(x => x.active)}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create requirement'}<span aria-hidden="true">→</span></button>
          {editingId && <button className="text-button" type="button" onClick={reset}>Cancel editing</button>}
        </form>
      </article>
      <article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">EXISTING RECORDS</p><h2>Configured requirements</h2></div><span className="role-count">{requirements.length}</span></div>
        {loading ? <p className="muted">Loading requirements…</p> : <div className="setup-record-list">
          {requirements.map(item => <div className="setup-record" key={item.id}><div><strong>{item.office_name}</strong><small>{item.session_name} ({item.academic_session}) · {item.enabled ? 'Enabled' : 'Disabled'} · {item.required ? 'Mandatory' : 'Optional'}</small><small>{item.programme_name ? item.programme_name : item.department_name ? item.department_name : 'All departments/programmes'}</small>{item.instructions && <small>{item.instructions}</small>}</div><div className="setup-actions"><button className="text-action" type="button" disabled={saving} onClick={() => edit(item)}>Edit</button><button className="text-action" type="button" disabled={saving} onClick={() => void toggle(item)}>{item.enabled ? 'Disable' : 'Enable'}</button></div></div>)}
          {requirements.length === 0 && <p className="muted">No clearance requirements configured yet.</p>}
        </div>}
      </article>
    </div>
    <p className="field-note">Only SuperAdmin can create, edit, enable or disable requirements. Each change is audited. Administrators retain payment-only access.</p>
  </section>;
}
