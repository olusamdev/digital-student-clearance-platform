import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type Student = { id: string; registration_number: string; full_name: string; gender: string | null; permanent_address: string | null; department: string | null; programme: string | null; phone_number: string | null };
type Requirement = { id: string; office_name: string; office_code: string; instructions: string | null; required: boolean; status: string; requested_at: string | null; decision_at: string | null; comments: { id: string; comment_text: string; author_role: string; created_at: string }[] };
type StudentSession = { id: string; session_id: string; session_name: string; academic_session: string | null; active: boolean; opens_at: string | null; closes_at: string | null; payment_unlocked_at: string | null; profile_confirmed_at: string | null; final_assent: string; final_assent_remarks: string | null; completed_at: string | null; requirements: Requirement[] };
type Dashboard = { student: Student; clearance_fee_kobo: number; sessions: StudentSession[] };

function toE164(value: string) {
  const raw = value.trim();
  if (raw.startsWith('+') && /^\+\d{10,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '+234' + digits.slice(1);
  if (digits.length === 10) return '+234' + digits;
  throw new Error('Enter a valid Nigerian phone number, e.g. 08012345678 or +2348012345678.');
}
const dateText = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const statusText = (value: string) => value.replaceAll('_', ' ');

export default function StudentPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [fullName, setFullName] = useState('');
  const [gender, setGender] = useState('');
  const [address, setAddress] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true); setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('student-portal', { body: { action: 'dashboard' } });
    setLoading(false);
    if (invokeError || data?.error) {
      setDashboard(null);
      setError(invokeError ? await describeFunctionError(invokeError, 'student-portal', 'Could not load your student record.') : String(data.error));
      return;
    }
    const result = data as Dashboard;
    setDashboard(result);
    setFullName(result.student.full_name || '');
    setGender(result.student.gender || '');
    setAddress(result.student.permanent_address || '');
  }, []);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession) setDashboard(null);
    });
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void loadDashboard();
    });
    return () => listener.subscription.unsubscribe();
  }, [loadDashboard]);

  async function sendOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setError(''); setNotice('');
    let normalized = '';
    try { normalized = toE164(phone); }
    catch (e) { setError(e instanceof Error ? e.message : 'Enter a valid phone number.'); setAuthBusy(false); return; }
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: normalized });
    setAuthBusy(false);
    if (otpError) { setError('Could not send a verification code. Confirm that student SMS sign-in is enabled for the college project.'); return; }
    setPhone(normalized); setOtpSent(true); setNotice('A verification code has been sent if this phone number can receive SMS.');
  }

  async function verifyOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setError(''); setNotice('');
    const normalized = toE164(phone);
    const { data, error: verifyError } = await supabase.auth.verifyOtp({ phone: normalized, token: otp.trim(), type: 'sms' });
    setAuthBusy(false);
    if (verifyError || !data.session) { setError('Verification failed. Check the code or request a new one.'); return; }
    setSession(data.session); setNotice('Phone verified. Loading your college record…');
    await loadDashboard();
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null); setDashboard(null); setOtpSent(false); setOtp(''); setNotice('You have signed out.');
  }

  async function invokeStudent(action: string, payload: Record<string, unknown> = {}) {
    setBusy(action); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('student-portal', { body: { action, payload } });
    setBusy('');
    if (invokeError) throw new Error(await describeFunctionError(invokeError, 'student-portal', 'The request could not be completed.'));
    if (data?.error) throw new Error(String(data.error));
    return data;
  }

  async function confirmProfile(event: FormEvent<HTMLFormElement>, item: StudentSession) {
    event.preventDefault();
    try {
      await invokeStudent('confirm_profile', { session_student_id: item.id, full_name: fullName.trim(), gender: gender.trim(), permanent_address: address.trim() });
      setNotice('Your particulars have been saved and confirmed.');
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not confirm your particulars.'); }
  }

  async function requestClearance(item: StudentSession) {
    if (!window.confirm('Submit your clearance requests to the required offices?')) return;
    try {
      await invokeStudent('request_clearance', { session_student_id: item.id });
      setNotice('Your clearance requests have been submitted to the relevant offices.');
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not submit clearance requests.'); }
  }

  if (!session) return (
    <main className="auth-layout">
      <section className="brand-panel">
        <div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div>
        <div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Your clearance, in one place.</h1><p>Verify your phone to view your official student record and track final-year clearance.</p></div>
        <p className="panel-footnote">Student access · Secure phone verification</p>
      </section>
      <section className="form-panel">
        <form className="login-card" onSubmit={otpSent ? verifyOtp : sendOtp}>
          <p className="eyebrow dark">STUDENT PORTAL</p><h2>{otpSent ? 'Verify your phone' : 'Student sign in'}</h2>
          <p className="muted">Use the phone number recorded by the college. A registration number alone is not sufficient to access a student record.</p>
          {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
          <label htmlFor="student-phone">Mobile phone number</label>
          <input id="student-phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08012345678" required disabled={otpSent} />
          {otpSent && <><label htmlFor="student-otp">SMS verification code</label><input id="student-otp" inputMode="numeric" autoComplete="one-time-code" value={otp} onChange={(e) => setOtp(e.target.value)} minLength={6} maxLength={8} required placeholder="Enter code" /><button className="text-button" type="button" onClick={() => { setOtpSent(false); setOtp(''); setError(''); }}>Change phone number</button></>}
          <button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Please wait…' : otpSent ? 'Verify and continue' : 'Send verification code'}<span aria-hidden="true">→</span></button>
          <p className="security-note">If your college-recorded phone number is outdated or shared, contact the college to correct it. Do not use another student's phone number.</p>
        </form><footer className="page-footer">COHT Digital Student Clearance Platform</footer>
      </section>
    </main>
  );

  return (
    <main className="dashboard-layout">
      <header className="topbar"><div className="brand-lockup"><div className="brand-mark small">COHT</div><span>Digital Clearance · Student</span></div><button className="secondary-button" type="button" onClick={() => void signOut()}>Sign out</button></header>
      <section className="welcome-block"><p className="eyebrow dark">STUDENT WORKSPACE</p><h1>{dashboard ? `Welcome, ${dashboard.student.full_name}` : 'Your student clearance'}</h1><p className="muted">View your particulars, payment gate, office decisions, and final clearance status.</p></section>
      {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
      {loading && <div className="panel"><p className="muted">Loading your verified college record…</p></div>}
      {!loading && !dashboard && <div className="panel"><h2>Student record not available</h2><p className="muted">The verified phone number did not resolve to one unique college record, or no clearance session has been assigned. Contact the college clearance office; do not create another account.</p><button className="secondary-button" type="button" onClick={() => void loadDashboard()}>Try again</button></div>}
      {dashboard && <>
        <section className="content-grid">
          <article className="panel account-panel"><div className="panel-heading"><div><p className="eyebrow dark">OFFICIAL RECORD</p><h2>Student particulars</h2></div><span className="status-pill"><span /> Verified phone</span></div>
            <dl className="details-list"><div><dt>Registration number</dt><dd>{dashboard.student.registration_number}</dd></div><div><dt>Department</dt><dd>{dashboard.student.department || 'Not assigned'}</dd></div><div><dt>Programme</dt><dd>{dashboard.student.programme || 'Not assigned'}</dd></div><div><dt>Phone</dt><dd>{dashboard.student.phone_number || 'Verified sign-in phone'}</dd></div></dl>
          </article>
          <article className="panel roles-panel"><div className="panel-heading"><div><p className="eyebrow dark">CLEARANCE FEE</p><h2>₦{(dashboard.clearance_fee_kobo / 100).toLocaleString('en-NG')}</h2></div></div><p className="muted">Payment must be verified before clearance requests can be submitted.</p><span className="directory-status inactive">Payment status is checked by the server</span><p className="field-note">Online payment initiation is not yet connected. Do not pay into a personal account; use only a payment option officially announced by the college.</p></article>
        </section>
        {!dashboard.sessions.length && <div className="panel"><h2>No clearance session assigned</h2><p className="muted">Your college record is recognised, but an active clearance session has not been assigned yet. Contact the clearance administrator.</p></div>}
        {dashboard.sessions.map((item) => <section className="panel clearance-request-card" key={item.id}>
          <div className="clearance-card-header"><div><p className="eyebrow dark">CLEARANCE SESSION</p><h2>{item.academic_session || item.session_name}</h2><p className="clearance-reg">{dashboard.student.registration_number}</p></div><span className={`clearance-status status-${item.final_assent === 'assented' ? 'cleared' : item.final_assent === 'declined' ? 'needs_attention' : 'requested'}`}>{item.final_assent === 'assented' ? 'Completed' : item.final_assent === 'declined' ? 'Assent declined' : item.final_assent === 'revoked' ? 'Assent revoked' : item.active ? 'In progress' : 'Session closed'}</span></div>
          {item.final_assent_remarks && <p className="clearance-instructions">Provost remarks: {item.final_assent_remarks}</p>}
          <div className="clearance-meta"><span><strong>Payment gate</strong>{item.payment_unlocked_at ? `Verified ${dateText(item.payment_unlocked_at)}` : 'Not verified'}</span><span><strong>Profile</strong>{item.profile_confirmed_at ? 'Confirmed' : 'Confirmation required'}</span><span><strong>Final decision</strong>{item.final_assent}</span><span><strong>Completed</strong>{dateText(item.completed_at)}</span></div>
          {!item.profile_confirmed_at && <form className="management-form" onSubmit={(e) => void confirmProfile(e, item)}><h3>Confirm your particulars</h3><p className="muted">Registration number, department, and programme are college-controlled and cannot be edited here. Contact the college to correct them.</p><label htmlFor={`student-name-${item.id}`}>Full name</label><input id={`student-name-${item.id}`} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={160} required /><label htmlFor={`student-gender-${item.id}`}>Gender</label><select id={`student-gender-${item.id}`} value={gender} onChange={(e) => setGender(e.target.value)}><option value="">Select</option><option value="Female">Female</option><option value="Male">Male</option><option value="Prefer not to say">Prefer not to say</option></select><label htmlFor={`student-address-${item.id}`}>Permanent address</label><textarea id={`student-address-${item.id}`} rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} /><button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === 'confirm_profile' ? 'Saving…' : 'Save and confirm particulars'}</button></form>}
          <div className="clearance-section-heading"><div><h3>Office requirements</h3><p className="muted">Track each required office's decision and remarks.</p></div><span className="role-count">{item.requirements.filter((r) => r.status === 'cleared').length}/{item.requirements.filter((r) => r.required).length}</span></div>
          {!item.requirements.length ? <p className="muted">Requirements have not been configured for this session.</p> : <div className="clearance-request-list">{item.requirements.map((req) => <article className="panel" key={req.id}><div className="clearance-card-header"><div><h3>{req.office_name}</h3><p className="clearance-reg">{req.office_code}</p></div><span className={`clearance-status status-${req.status}`}>{statusText(req.status)}</span></div>{req.instructions && <p className="clearance-instructions">{req.instructions}</p>}{req.comments.map((c) => <div className="clearance-comment" key={c.id}><p>{c.comment_text}</p><small>{c.author_role.replaceAll('_', ' ')} · {dateText(c.created_at)}</small></div>)}</article>)}</div>}
          {item.final_assent !== 'assented' && <button className="primary-button" type="button" disabled={Boolean(busy) || !item.payment_unlocked_at || !item.profile_confirmed_at || !item.active} onClick={() => void requestClearance(item)}>{busy === 'request_clearance' ? 'Submitting…' : 'Submit clearance requests'}</button>}
        </section>)}
      </>}
      <p className="dashboard-footnote">Student data is served through an authenticated, server-side access check.</p>
    </main>
  );
}
