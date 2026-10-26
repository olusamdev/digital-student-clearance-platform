import { useState, type FormEvent } from 'react';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type Lookup = { student: { registration_number: string; full_name: string }; account_ready: boolean; payment_verified: boolean };

export default function StudentAccessTools({ canManageSupport, canManageStudents }: { canManageSupport: boolean; canManageStudents: boolean }) {
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [supportNumber, setSupportNumber] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function findStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('lookup'); setError(''); setNotice(''); setLookup(null);
    const { data, error: invokeError } = await supabase.functions.invoke('student-portal', {
      body: { action: 'lookup_record', payload: { registration_number: registrationNumber.trim().toUpperCase() } },
    });
    setBusy('');
    if (invokeError || data?.error) {
      setError(invokeError ? await describeFunctionError(invokeError, 'student-portal', 'Could not find the student.') : String(data.error));
      return;
    }
    setLookup(data as Lookup);
  }

  async function startAssistedPayment() {
    if (!lookup) return;
    setBusy('payment'); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('student-payments', {
      body: { action: 'initiate_admin', payload: { registration_number: lookup.student.registration_number } },
    });
    setBusy('');
    if (invokeError || data?.error) {
      setError(invokeError ? await describeFunctionError(invokeError, 'student-payments', 'Could not start the payment.') : String(data.error));
      return;
    }
    if (data?.already_paid) { setNotice('A verified payment is already linked to this student. No second payment was started.'); return; }
    if (!data?.authorization_url) { setError('Paystack did not return a payment link.'); return; }
    window.location.assign(String(data.authorization_url));
  }

  async function issueCode() {
    if (!lookup) return;
    setBusy('code'); setError(''); setNotice(''); setCode('');
    const action = 'issue_password_reset';
    const { data, error: invokeError } = await supabase.functions.invoke('manage-student-access', {
      body: { action, payload: { registration_number: lookup.student.registration_number } },
    });
    setBusy('');
    if (invokeError || data?.error) {
      setError(invokeError ? await describeFunctionError(invokeError, 'manage-student-access', 'Could not issue the code.') : String(data.error));
      return;
    }
    setCode(String(data.code || ''));
    setNotice(`Password-reset code issued for ${data.student?.full_name || lookup.student.full_name}. It expires in 30 minutes. Give it directly to the verified student; it will not be shown again after leaving this page.`);
  }

  async function loadSupportNumber() {
    setBusy('support-load'); setError('');
    const { data, error: invokeError } = await supabase.functions.invoke('manage-student-access', { body: { action: 'get_support_number' } });
    setBusy('');
    if (invokeError || data?.error) {
      setError(invokeError ? await describeFunctionError(invokeError, 'manage-student-access', 'Could not load the support number.') : String(data.error));
      return;
    }
    setSupportNumber(String(data.whatsapp || ''));
    setNotice(data.whatsapp ? 'Current support number loaded.' : 'No support number is configured yet.');
  }

  async function saveSupportNumber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy('support-save'); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('manage-student-access', {
      body: { action: 'set_support_number', payload: { whatsapp: supportNumber } },
    });
    setBusy('');
    if (invokeError || data?.error) {
      setError(invokeError ? await describeFunctionError(invokeError, 'manage-student-access', 'Could not save the support number.') : String(data.error));
      return;
    }
    setNotice('Student WhatsApp support number saved.');
  }

  return <section className="management-section">
    <div className="section-title"><div><p className="eyebrow dark">STUDENT SERVICES</p><h2>Student payment and account assistance</h2><p className="muted">This section is for paying a clearance fee on behalf of a student only.</p></div></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status">{notice}</div>}
    <div className="management-grid">
      {canManageStudents && <>
      <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow dark">ASSISTED PAYMENT</p><h2>Pay for a student</h2></div></div>
        <form className="management-form" onSubmit={findStudent}>
          <label htmlFor="assisted-reg">Student registration number</label>
          <input id="assisted-reg" value={registrationNumber} onChange={e => { setRegistrationNumber(e.target.value); setLookup(null); setCode(''); }} maxLength={100} required placeholder="Enter the exact registration number" />
          <button className="secondary-button" type="submit" disabled={busy !== ''}>{busy === 'lookup' ? 'Checking record…' : 'Find student'}</button>
        </form>
        {lookup && <div className="student-match"><p><strong>{lookup.student.full_name}</strong></p><p className="field-note">Registration number: {lookup.student.registration_number}</p><p className="field-note">Payment: {lookup.payment_verified ? 'Verified' : 'Not verified'} · Account: {lookup.account_ready ? 'Activated' : 'Not activated'}</p>{lookup.payment_verified ? <p className="alert success">A verified payment already exists. Do not start another payment.</p> : <button className="primary-button" type="button" onClick={() => void startAssistedPayment()} disabled={busy !== ''}>{busy === 'payment' ? 'Opening Paystack…' : 'Continue to Paystack payment'}<span aria-hidden="true">→</span></button>}</div>}
        <p className="field-note">Paystack uses the signed-in staff account for its receipt email. The payment is recorded against the student registration number, not the student's email.</p>
      </article>

      </>}
      {canManageSupport && <article className="panel">
        <div className="panel-heading"><div><p className="eyebrow dark">SUPERADMIN SETTING</p><h2>Student WhatsApp support</h2></div></div>
        <form className="management-form" onSubmit={saveSupportNumber}>
          <button className="secondary-button" type="button" onClick={() => void loadSupportNumber()} disabled={busy !== ''}>{busy === 'support-load' ? 'Loading…' : 'Load current number'}</button>
          <label htmlFor="support-whatsapp">WhatsApp number with country code</label>
          <input id="support-whatsapp" inputMode="numeric" value={supportNumber} onChange={e => setSupportNumber(e.target.value)} placeholder="2348012345678" maxLength={40} />
          <p className="field-note">Use digits only, including country code. Leave blank to remove the support contact.</p>
          <button className="primary-button" type="submit" disabled={busy !== ''}>{busy === 'support-save' ? 'Saving…' : 'Save support number'}<span aria-hidden="true">→</span></button>
        </form>
      </article>}
    </div>
  </section>;
}
