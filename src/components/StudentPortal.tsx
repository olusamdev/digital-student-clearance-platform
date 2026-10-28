import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type Student = { id: string; registration_number: string; full_name: string; gender: string | null; permanent_address: string | null; department_id: string | null; programme_id: string | null; department: string | null; programme: string | null; phone_number: string | null };
type DepartmentOption = { id: string; code: string; name: string };
type ProgrammeOption = { id: string; department_id: string; code: string; name: string };
type StudentReceipt = { id: string; original_filename: string; mime_type: string; size_bytes: number; uploaded_at: string | null; clearance_request_id: string };
type Requirement = { id: string; request_id: string | null; office_name: string; office_code: string; instructions: string | null; required: boolean; status: string; requested_at: string | null; decision_at: string | null; receipts: StudentReceipt[]; comments: { id: string; comment_text: string; author_role: string; created_at: string }[] };
type StudentSession = { id: string; session_id: string; session_name: string; academic_session: string | null; active: boolean; opens_at: string | null; closes_at: string | null; payment_unlocked_at: string | null; profile_confirmed_at: string | null; final_assent: string; final_assent_remarks: string | null; completed_at: string | null; requirements: Requirement[] };
type Dashboard = { student: Student; clearance_fee_kobo: number; sessions: StudentSession[]; departments: DepartmentOption[]; programmes: ProgrammeOption[] };
type LookupResult = { student: { registration_number: string; full_name: string }; account_ready: boolean; auth_email: string | null; payment_verified: boolean; payment_pending: boolean; activation_requires_code: boolean; clearance_fee_kobo: number; session_available: boolean };

const dateText = (value: string | null) => value ? new Date(value).toLocaleString() : '—';
const statusText = (value: string) => value.replaceAll('_', ' ');

export default function StudentPortal() {
  const [session, setSession] = useState<Session | null>(null);
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [authStep, setAuthStep] = useState<'registration' | 'confirm' | 'password' | 'payment' | 'setup' | 'reset'>('registration');
  const [password, setPassword] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [fullName, setFullName] = useState('');
  const [gender, setGender] = useState('');
  const [address, setAddress] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [programmeId, setProgrammeId] = useState('');

  const loadDashboard = useCallback(async () => {
    setLoading(true); setError('');
    const { data: linkData, error: linkError } = await supabase.functions.invoke('student-portal', { body: { action: 'link_account' } });
    if (linkError || linkData?.error) {
      setLoading(false); setDashboard(null);
      setError(linkError ? await describeFunctionError(linkError, 'student-portal', 'Could not finish student account setup.') : String(linkData.error));
      return;
    }
    const { data, error: invokeError } = await supabase.functions.invoke('student-portal', { body: { action: 'dashboard' } });
    setLoading(false);
    if (invokeError || data?.error) {
      setDashboard(null);
      setError(invokeError ? await describeFunctionError(invokeError, 'student-portal', 'Could not load your student record.') : String(data.error));
      return;
    }
    const result = data as Dashboard;
    const receiptResults = await Promise.all(result.sessions.map(async (item) => {
      const { data: receiptData } = await supabase.functions.invoke('bursary-receipts', {
        body: { action: 'list_student_receipts', payload: { session_student_id: item.id } },
      });
      return { sessionStudentId: item.id, receipts: Array.isArray(receiptData?.receipts) ? receiptData.receipts as StudentReceipt[] : [] };
    }));
    const receiptsBySession = new Map(receiptResults.map((row) => [row.sessionStudentId, row.receipts]));
    result.sessions = result.sessions.map((item) => ({
      ...item,
      requirements: item.requirements.map((req) => ({
        ...req,
        receipts: (receiptsBySession.get(item.id) ?? []).filter((receipt) => receipt.clearance_request_id === req.request_id),
      })),
    }));
    setDashboard(result);
    setFullName(result.student.full_name || '');
    const savedGender = (result.student.gender || '').toLowerCase();
    setGender(savedGender === 'male' || savedGender === 'female' ? savedGender : '');
    setAddress(result.student.permanent_address || '');
    setDepartmentId(result.student.department_id || '');
    setProgrammeId(result.student.programme_id || '');
  }, []);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      setSession(nextSession);
      if (!nextSession) setDashboard(null);
    });
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void loadDashboard();
    });
    return () => listener.subscription.unsubscribe();
  }, [loadDashboard]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reference = params.get('reference') || params.get('trxref');
    if (!reference) return;
    setPaymentReference(reference);
    window.sessionStorage.removeItem('dscp-payment-email');
    window.history.replaceState({}, '', window.location.pathname);
    let cancelled = false;
    void (async () => {
      setAuthBusy(true); setError(''); setNotice('Checking your Paystack payment securely…');
      const { data: verified, error: verifyError } = await supabase.functions.invoke('student-payments', {
        body: { action: 'verify', payload: { reference } },
      });
      if (cancelled) return;
      if (verifyError || verified?.error || !verified?.registration_number) {
        setAuthBusy(false); setNotice('');
        setError(verifyError ? await describeFunctionError(verifyError, 'student-payments', 'Could not verify your payment.') : String(verified?.error || 'Payment verification could not be completed.'));
        return;
      }
      const reg = String(verified.registration_number);
      setRegistrationNumber(reg);
      const { data: record, error: lookupError } = await supabase.functions.invoke('student-portal', {
        body: { action: 'lookup_record', payload: { registration_number: reg } },
      });
      if (cancelled) return;
      setAuthBusy(false); setNotice('');
      if (lookupError || record?.error) {
        setError(lookupError ? await describeFunctionError(lookupError, 'student-portal', 'Payment was verified, but the student record could not be reloaded.') : String(record.error));
        return;
      }
      const found = record as LookupResult;
      setLookup(found);
      setAuthStep(found.account_ready ? 'password' : found.payment_verified ? 'setup' : 'payment');
      setNotice(found.payment_verified ? 'Payment verified. Continue setting up your student account; do not pay again.' : 'Payment reference checked. Follow the next step shown below.');
    })();
    return () => { cancelled = true; };
  }, []);

  async function lookupRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('student-portal', { body: { action: 'lookup_record', payload: { registration_number: registrationNumber.trim().toUpperCase() } } });
    setAuthBusy(false);
    if (invokeError || data?.error) {
      setLookup(null); setAuthStep('registration');
      setError(invokeError ? await describeFunctionError(invokeError, 'student-portal', 'Could not check this registration number.') : String(data.error));
      return;
    }
    const found = data as LookupResult;
    setLookup(found); setAuthStep(found.account_ready ? 'password' : found.payment_verified ? 'setup' : 'confirm');
  }

  async function continueAfterConfirmation() {
    if (!lookup) return;
    setError(''); setNotice('');
    if (lookup.account_ready) { setAuthStep('password'); return; }
    if (lookup.payment_verified) { setAuthStep('setup'); return; }
    if (!lookup.session_available) { setError('The college has not opened a clearance session yet. No payment is due until the session is available.'); return; }
    if (lookup.payment_pending) {
      setNotice('A previous payment is still pending. Enter its Paystack reference below to verify it before attempting another payment.');
      setAuthStep('payment'); return;
    }
    setAuthStep('payment');
  }

  async function startPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup) return;
    setAuthBusy(true); setError(''); setNotice('');
    const { data, error: paymentError } = await supabase.functions.invoke('student-payments', {
      body: { action: 'initiate', payload: { registration_number: lookup.student.registration_number } },
    });
    setAuthBusy(false);
    if (paymentError || data?.error) {
      setError(paymentError ? await describeFunctionError(paymentError, 'student-payments', 'Could not start payment.') : String(data.error));
      return;
    }
    if (data?.already_paid) {
      const { data: refreshed, error: refreshError } = await supabase.functions.invoke('student-portal', {
        body: { action: 'lookup_record', payload: { registration_number: lookup.student.registration_number } },
      });
      if (refreshError || refreshed?.error) {
        setError('A previous payment exists, but the student record could not be reloaded. Return to registration lookup and retry; do not pay again.');
        return;
      }
      const found = refreshed as LookupResult;
      setLookup(found);
      setNotice('A verified payment already exists. Continue account setup; do not pay again.');
      setAuthStep(found.payment_verified && !found.account_ready ? 'setup' : found.account_ready ? 'password' : 'payment');
      return;
    }
    if (!data?.authorization_url) { setError('Paystack did not return a payment link. Please try again.'); return; }
    window.location.assign(String(data.authorization_url));
  }

  async function contactSupport() {
    if (!lookup) return;
    setAuthBusy(true); setError(''); setNotice('');
    const { data, error: supportError } = await supabase.functions.invoke('manage-student-access', { body: { action: 'get_support_number' } });
    setAuthBusy(false);
    if (supportError || data?.error) {
      setError(supportError ? await describeFunctionError(supportError, 'manage-student-access', 'Could not load the support contact.') : String(data?.error));
      return;
    }
    const number = String(data?.whatsapp || '').replace(/[^0-9]/g, '');
    if (!number) { setError('The college has not configured its WhatsApp support number yet. Contact the Registrar’s office.'); return; }
    const message = `Hello, I need help confirming my clearance payment. Registration number: ${lookup.student.registration_number}.`;
    window.location.assign(`https://wa.me/${number}?text=${encodeURIComponent(message)}`);
  }

  async function verifyPaymentReference() {
    const reference = paymentReference.trim();
    if (!reference) { setError('Enter the Paystack reference from your payment page or receipt.'); return; }
    setAuthBusy(true); setError(''); setNotice('Checking the existing payment reference…');
    const { data, error: verifyError } = await supabase.functions.invoke('student-payments', {
      body: { action: 'verify', payload: { reference } },
    });
    setAuthBusy(false);
    if (verifyError || data?.error || !data?.registration_number) {
      setNotice('');
      setError(verifyError ? await describeFunctionError(verifyError, 'student-payments', 'Could not verify the existing payment.') : String(data?.error || 'Payment could not be verified.'));
      return;
    }
    const { data: record, error: lookupError } = await supabase.functions.invoke('student-portal', {
      body: { action: 'lookup_record', payload: { registration_number: data.registration_number } },
    });
    if (lookupError || record?.error) {
      setNotice('');
      setError(lookupError ? await describeFunctionError(lookupError, 'student-portal', 'Payment was verified, but the student record could not be reloaded.') : String(record.error));
      return;
    }
    const found = record as LookupResult;
    setLookup(found); setRegistrationNumber(found.student.registration_number);
    setAuthStep(found.account_ready ? 'password' : found.payment_verified ? 'setup' : 'payment');
    setNotice(found.payment_verified ? 'Payment verified. Continue account setup; do not pay again.' : 'Payment status checked. Follow the next step below.');
  }

  async function createStudentAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup) return;
    if (password.length < 8) { setError('Choose a password with at least 8 characters.'); return; }
    if (password !== confirmNewPassword) { setError('The passwords do not match.'); return; }
    setAuthBusy(true); setError(''); setNotice('');
    const { data, error: activationError } = await supabase.functions.invoke('manage-student-access', {
      body: { action: 'complete_student_activation', payload: { registration_number: lookup.student.registration_number, password } },
    });
    if (activationError || data?.error || !data?.auth_email) {
      setAuthBusy(false);
      setError(activationError ? await describeFunctionError(activationError, 'manage-student-access', 'Could not activate the student account.') : String(data?.error || 'Account activation could not be completed.'));
      return;
    }
    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({ email: String(data.auth_email), password });
    setAuthBusy(false);
    if (signInError || !signedIn.session) {
      setNotice('Your account was activated. Return to registration lookup and sign in with the password you just created.');
      setAuthStep('password'); setPassword(''); setConfirmNewPassword(''); setAccessCode('');
      return;
    }
    setSession(signedIn.session);
    setPassword(''); setConfirmNewPassword(''); setAccessCode('');
    await loadDashboard();
  }

  async function signInStudent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup?.auth_email) { setError('This student account is not ready for password sign-in.'); return; }
    setAuthBusy(true); setError(''); setNotice('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: lookup.auth_email, password });
    setAuthBusy(false);
    if (signInError || !data.session) { setError('Sign-in failed. Check your password or use password recovery.'); return; }
    setSession(data.session); await loadDashboard();
  }

  async function requestPasswordReset() {
    setError('');
    setNotice('For your protection, password recovery must be initiated by an authorised college administrator. Contact the college and ask for a one-time reset code.');
    setAuthStep('reset');
    setAccessCode(''); setNewPassword(''); setConfirmNewPassword('');
  }

  async function completePasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup) { setError('Return to registration lookup and enter your registration number first.'); return; }
    if (!accessCode.trim()) { setError('Enter the password-reset code issued by the college.'); return; }
    if (newPassword.length < 8) { setError('Choose a password with at least 8 characters.'); return; }
    if (newPassword !== confirmNewPassword) { setError('The passwords do not match.'); return; }
    setAuthBusy(true); setError(''); setNotice('');
    const { data, error: resetError } = await supabase.functions.invoke('manage-student-access', {
      body: { action: 'complete_password_reset', payload: { registration_number: lookup.student.registration_number, code: accessCode, password: newPassword } },
    });
    if (resetError || data?.error) {
      setAuthBusy(false);
      setError(resetError ? await describeFunctionError(resetError, 'manage-student-access', 'Could not reset the password.') : String(data?.error || 'Password reset could not be completed.'));
      return;
    }
    const authEmail = lookup.auth_email;
    if (!authEmail) { setAuthBusy(false); setError('Password was changed, but the sign-in identifier could not be loaded. Return to registration lookup and try again.'); return; }
    const { data: signedIn, error: signInError } = await supabase.auth.signInWithPassword({ email: authEmail, password: newPassword });
    setAuthBusy(false);
    if (signInError || !signedIn.session) {
      setNotice('Password reset completed. Return to registration lookup and sign in with your new password.');
      setAuthStep('password'); setNewPassword(''); setConfirmNewPassword(''); setAccessCode('');
      return;
    }
    setSession(signedIn.session);
    setNewPassword(''); setConfirmNewPassword(''); setAccessCode('');
    await loadDashboard();
  }

  async function saveNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 8) { setError('Choose a password with at least 8 characters.'); return; }
    if (newPassword !== confirmNewPassword) { setError('The passwords do not match.'); return; }
    setAuthBusy(true); setError(''); setNotice('');
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setAuthBusy(false);
    if (updateError) { setError('The password could not be updated. Reopen the latest password-reset link and try again.'); return; }
    setRecoveryMode(false); setNewPassword(''); setConfirmNewPassword('');
    setNotice('Your password has been updated.');
    await loadDashboard();
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null); setDashboard(null); setRegistrationNumber(''); setLookup(null); setAuthStep('registration'); setPassword(''); setRecoveryMode(false); setNewPassword(''); setConfirmNewPassword(''); setNotice('You have signed out.');
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
      await invokeStudent('confirm_profile', { session_student_id: item.id, full_name: fullName.trim(), gender: gender.trim(), permanent_address: address.trim(), department_id: departmentId, programme_id: programmeId });
      setNotice('Your particulars have been saved and confirmed.');
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not confirm your particulars.'); }
  }

  async function uploadBursaryReceipt(event: React.ChangeEvent<HTMLInputElement>, item: StudentSession, req: Requirement) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !req.request_id) return;
    const allowed = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.type)) { setError('Upload a PDF, JPG, PNG, or WebP receipt.'); return; }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) { setError('Receipt files must be 5 MB or smaller.'); return; }
    setBusy('receipt-' + req.id); setError(''); setNotice('');
    try {
      const { data: prepared, error: prepareError } = await supabase.functions.invoke('bursary-receipts', {
        body: { action: 'create_upload', payload: { session_student_id: item.id, clearance_request_id: req.request_id, filename: file.name, mime_type: file.type, size_bytes: file.size } },
      });
      if (prepareError || prepared?.error || !prepared?.path || !prepared?.token || !prepared?.receipt_id) throw new Error(prepared?.error || 'Could not prepare a secure receipt upload.');
      const { error: uploadError } = await supabase.storage.from('bursary-receipts').uploadToSignedUrl(String(prepared.path), String(prepared.token), file, { contentType: file.type, upsert: false });
      if (uploadError) throw new Error('The receipt file could not be uploaded. Please try again.');
      const { data: completed, error: completeError } = await supabase.functions.invoke('bursary-receipts', {
        body: { action: 'complete_upload', payload: { session_student_id: item.id, receipt_id: prepared.receipt_id } },
      });
      if (completeError || completed?.error) throw new Error(completed?.error || 'The receipt could not be submitted for review.');
      setNotice('Receipt uploaded and submitted to the Bursar for review. This does not clear your Bursary request.');
      await loadDashboard();
    } catch (e) { setError(e instanceof Error ? e.message : 'Receipt upload failed.'); }
    finally { setBusy(''); }
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
      <section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Your clearance, in one place.</h1><p>Use your official registration number to access student clearance.</p></div><p className="panel-footnote">Student access · Password sign-in</p></section>
      <section className="form-panel"><form className="login-card" onSubmit={authStep === 'registration' ? lookupRecord : authStep === 'password' ? signInStudent : authStep === 'payment' ? startPayment : authStep === 'setup' ? createStudentAccount : authStep === 'reset' ? completePasswordReset : (e) => { e.preventDefault(); void continueAfterConfirmation(); }}>
        <p className="eyebrow dark">STUDENT PORTAL</p>
        <h2>{authStep === 'registration' ? 'Find your student record' : authStep === 'confirm' ? 'Confirm your record' : authStep === 'password' ? 'Welcome back' : authStep === 'payment' ? 'Clearance payment' : authStep === 'reset' ? 'Reset your password' : 'Create your password'}</h2>
        <p className="muted">{authStep === 'registration' ? 'Enter your registration number to continue.' : authStep === 'confirm' ? 'Check that the registered name below belongs to you.' : authStep === 'password' ? 'Enter your password. Your registration number is already confirmed.' : authStep === 'payment' ? 'Your record is found. The clearance fee must be paid before account setup.' : authStep === 'reset' ? 'Enter the one-time reset code issued by an authorised college administrator.' : lookup?.activation_requires_code ? 'Your payment is recorded. Enter the one-time code issued by the college and choose a private password.' : 'Your payment is recorded. Create a password to activate your student account.'}</p>
        {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
        {authStep === 'registration' && <><label htmlFor="student-registration">Registration number</label><input id="student-registration" value={registrationNumber} onChange={(e) => setRegistrationNumber(e.target.value)} maxLength={100} required autoComplete="off" placeholder="Your official registration number" /><button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Checking record…' : 'Continue'}<span aria-hidden="true">→</span></button></>}
        {authStep === 'confirm' && lookup && <><div className="panel"><p className="muted">Registered name</p><h2>{lookup.student.full_name}</h2><p className="clearance-reg">{lookup.student.registration_number}</p><p>Hello, are you {lookup.student.full_name}?</p></div><button className="primary-button" type="submit">Yes, that's me <span aria-hidden="true">→</span></button><button className="secondary-button" type="button" onClick={() => { setLookup(null); setRegistrationNumber(''); setAccessCode(''); setPaymentReference(''); setAuthStep('registration'); setError(''); }}>No, enter the correct registration number</button></>}
        {authStep === 'password' && <><label htmlFor="student-password">Password</label><input id="student-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Signing in…' : 'Sign in'}<span aria-hidden="true">→</span></button><button className="text-button" type="button" onClick={() => void requestPasswordReset()} disabled={authBusy}>Forgot password? Contact an administrator</button></>}
        {authStep === 'payment' && lookup && <><div className="panel"><p className="muted">Student</p><h3>{lookup.student.full_name}</h3><p className="clearance-reg">{lookup.student.registration_number}</p><h2>₦{(lookup.clearance_fee_kobo / 100).toLocaleString('en-NG')}</h2></div>{lookup.payment_pending && <><p className="field-note">A previous payment is still being reconciled. Verify its reference before starting another payment.</p><label htmlFor="student-payment-reference">Existing Paystack reference</label><input id="student-payment-reference" value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} maxLength={200} autoComplete="off" placeholder="DSCP-…" /><button className="secondary-button" type="button" disabled={authBusy || !paymentReference.trim()} onClick={() => void verifyPaymentReference()}>{authBusy ? 'Verifying…' : 'Verify previous payment'}</button></>}{!lookup.payment_pending && <><p className="field-note">You do not need a personal email account to use the student portal. If you have already paid, do not pay again.</p><button className="primary-button" type="submit" disabled={authBusy || !lookup.session_available}>{authBusy ? 'Connecting to Paystack…' : 'Pay clearance fee'}<span aria-hidden="true">→</span></button></>}</>}
        {authStep === 'setup' && <><div className="panel"><p className="muted">Verified clearance payment</p><h3>{lookup?.student.full_name}</h3><p className="clearance-reg">{lookup?.student.registration_number}</p><h2>₦{((lookup?.clearance_fee_kobo || 0) / 100).toLocaleString('en-NG')}</h2></div><p className="field-note">Your clearance payment is verified. Create your password to activate your account. No activation code is required.</p><label htmlFor="student-new-password">Create password</label><input id="student-new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><label htmlFor="student-confirm-new-password">Confirm password</label><input id="student-confirm-new-password" type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Activating account…' : 'Create password and continue'}<span aria-hidden="true">→</span></button></>}
        {authStep === 'reset' && <><p className="field-note">An authorised college administrator must verify your identity and issue a reset code. The administrator cannot see the new password you choose.</p><label htmlFor="student-reset-code">One-time password-reset code</label><input id="student-reset-code" value={accessCode} onChange={(e) => setAccessCode(e.target.value.toUpperCase())} minLength={8} maxLength={40} autoComplete="one-time-code" required /><label htmlFor="student-reset-password">New password</label><input id="student-reset-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><label htmlFor="student-reset-confirm">Confirm new password</label><input id="student-reset-confirm" type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Resetting password…' : 'Set new password'}<span aria-hidden="true">→</span></button></>}
        {authStep === 'payment' && <button className="secondary-button" type="button" onClick={() => void contactSupport()} disabled={authBusy}>Already paid? Contact support on WhatsApp</button>}
        {authStep !== 'registration' && <button className="text-button" type="button" onClick={() => { setAuthStep('registration'); setLookup(null); setRegistrationNumber(''); setPassword(''); setAccessCode(''); setPaymentReference(''); setError(''); setNotice(''); }}>Use another registration number</button>}
      </form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section>
    </main>
  );

  if (recoveryMode && session) return (
    <main className="auth-layout">
      <section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Secure your account.</h1><p>Choose a new password to regain access to your student clearance.</p></div></section>
      <section className="form-panel"><form className="login-card" onSubmit={saveNewPassword}><p className="eyebrow dark">PASSWORD RECOVERY</p><h2>Set a new password</h2><p className="muted">Use at least 8 characters and keep it private.</p>{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="student-reset-password">New password</label><input id="student-reset-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><label htmlFor="student-reset-confirm">Confirm new password</label><input id="student-reset-confirm" type="password" value={confirmNewPassword} onChange={(e) => setConfirmNewPassword(e.target.value)} minLength={8} maxLength={128} autoComplete="new-password" required /><button className="primary-button" type="submit" disabled={authBusy}>{authBusy ? 'Updating password…' : 'Update password'}<span aria-hidden="true">→</span></button><button className="text-button" type="button" onClick={() => void signOut()}>Cancel and sign out</button></form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section>
    </main>
  );

  return (
    <main className="dashboard-layout">
      <header className="topbar"><div className="brand-lockup"><div className="brand-mark small">COHT</div><span>Digital Clearance · Student</span></div><button className="secondary-button" type="button" onClick={() => void signOut()}>Sign out</button></header>
      <section className="welcome-block"><h1>{dashboard ? `Welcome, ${dashboard.student.full_name}` : 'Your student clearance'}</h1><p className="muted">View your particulars, payment gate, office decisions, and final clearance status.</p></section>
      {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
      {loading && <div className="panel"><p className="muted">Loading your verified college record…</p></div>}
      {!loading && !dashboard && <div className="panel"><h2>Student record not available</h2><p className="muted">Your verified phone number could not be linked to a matching name and registration number, or no clearance session has been assigned. Check your details or contact the college clearance office.</p><button className="secondary-button" type="button" onClick={() => void loadDashboard()}>Try again</button></div>}
      {dashboard && <>

        {!dashboard.sessions.length && <div className="panel"><h2>No clearance session assigned</h2><p className="muted">Your college record is recognised, but an active clearance session has not been assigned yet. Contact the clearance administrator.</p></div>}
        {dashboard.sessions.map((item) => <section className="panel clearance-request-card" key={item.id}>
          <div className="clearance-card-header"><div><p className="eyebrow dark">CLEARANCE SESSION</p><h2>{item.academic_session || item.session_name}</h2><p className="clearance-reg">{dashboard.student.registration_number}</p></div><span className={`clearance-status status-${item.final_assent === 'assented' ? 'cleared' : item.final_assent === 'declined' ? 'needs_attention' : 'requested'}`}>{item.final_assent === 'assented' ? 'Completed' : item.final_assent === 'declined' ? 'Assent declined' : item.final_assent === 'revoked' ? 'Assent revoked' : item.active ? 'In progress' : 'Session closed'}</span></div>
          {item.final_assent_remarks && <p className="clearance-instructions">Provost remarks: {item.final_assent_remarks}</p>}
          <div className="clearance-meta"><span><strong>Payment gate</strong>{item.payment_unlocked_at ? `Verified ${dateText(item.payment_unlocked_at)}` : 'Not verified'}</span><span><strong>Profile</strong>{item.profile_confirmed_at ? 'Confirmed' : 'Confirmation required'}</span><span><strong>Final decision</strong>{item.final_assent}</span><span><strong>Completed</strong>{dateText(item.completed_at)}</span></div>
          {!item.profile_confirmed_at && <form className="management-form" onSubmit={(e) => void confirmProfile(e, item)}><h3>Confirm your particulars</h3><label htmlFor={`student-name-${item.id}`}>Full name</label><input id={`student-name-${item.id}`} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={160} required /><label htmlFor={`student-department-${item.id}`}>Department</label><select id={`student-department-${item.id}`} value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setProgrammeId(''); }} required><option value="">Select department</option>{dashboard.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select><label htmlFor={`student-programme-${item.id}`}>Programme</label><select id={`student-programme-${item.id}`} value={programmeId} onChange={(e) => setProgrammeId(e.target.value)} required disabled={!departmentId}><option value="">Select programme</option>{dashboard.programmes.filter((p) => p.department_id === departmentId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><label htmlFor={`student-gender-${item.id}`}>Gender</label><select id={`student-gender-${item.id}`} value={gender} onChange={(e) => setGender(e.target.value)}><option value="">Select</option><option value="female">Female</option><option value="male">Male</option></select><label htmlFor={`student-address-${item.id}`}>Permanent address</label><textarea id={`student-address-${item.id}`} rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} /><button className="primary-button" type="submit" disabled={Boolean(busy)}>{busy === 'confirm_profile' ? 'Saving…' : 'Save and confirm particulars'}</button></form>}
          <div className="clearance-section-heading"><div><h3>Office requirements</h3><p className="muted">Track each required office's decision and remarks.</p></div><span className="role-count">{item.requirements.filter((r) => r.status === 'cleared').length}/{item.requirements.filter((r) => r.required).length}</span></div>
          {!item.requirements.length ? <p className="muted">The college has not configured the required clearance offices for this session yet. Clearance requests cannot be submitted until the requirements are configured.</p> : <div className="clearance-request-list">{item.requirements.map((req) => <article className="panel" key={req.id}><div className="clearance-card-header"><div><h3>{req.office_name}</h3><p className="clearance-reg">{req.office_code}</p></div><span className={`clearance-status status-${req.status}`}>{statusText(req.status)}</span></div>{req.instructions && <p className="clearance-instructions">{req.instructions}</p>}{(req.office_code.toLowerCase() === 'bur' || /bursar|bursary/i.test(req.office_name)) && <div className="bursary-receipt-panel"><h4>Payment receipt for Bursary</h4><p className="muted">Upload a PDF or image receipt (maximum 5 MB). Only the Bursar can view or download it. Uploading does not clear your request.</p>{req.receipts.map((receipt) => <p className="field-note" key={receipt.id}>Submitted: {receipt.original_filename} · {receipt.uploaded_at ? dateText(receipt.uploaded_at) : 'Processing'}</p>)}{req.status !== 'cleared' && req.request_id && <label className="secondary-button" htmlFor={'receipt-' + item.id + '-' + req.id}>{busy === 'receipt-' + req.id ? 'Uploading receipt…' : req.receipts.length ? 'Upload another receipt' : 'Choose receipt file'}</label>}<input id={'receipt-' + item.id + '-' + req.id} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" hidden disabled={Boolean(busy) || req.status === 'cleared' || !req.request_id} onChange={(e) => void uploadBursaryReceipt(e, item, req)} /></div>}{req.comments.map((c) => <div className="clearance-comment" key={c.id}><p>{c.comment_text}</p><small>{c.author_role.replaceAll('_', ' ')} · {dateText(c.created_at)}</small></div>)}</article>)}</div>}
          {item.final_assent !== 'assented' && <button className="primary-button" type="button" disabled={Boolean(busy) || !item.payment_unlocked_at || !item.profile_confirmed_at || !item.active} onClick={() => void requestClearance(item)}>{busy === 'request_clearance' ? 'Submitting…' : 'Submit clearance requests'}</button>}
        </section>)}
      </>}
      <footer className="dashboard-account-footer" aria-label="Student account status">
        {dashboard && <><div><strong>Account status:</strong> Verified <span className="footer-separator">·</span> <strong>Student:</strong> {dashboard.student.full_name} <span className="footer-separator">·</span> <strong>Registration number:</strong> {dashboard.student.registration_number}</div><div><strong>Department:</strong> {dashboard.student.department || 'Not assigned'} <span className="footer-separator">·</span> <strong>Programme:</strong> {dashboard.student.programme || 'Not assigned'} <span className="footer-separator">·</span> <strong>Phone:</strong> {dashboard.student.phone_number || 'Verified sign-in phone'}</div></>}
        <p className="dashboard-footnote">Student data is served through an authenticated, server-side access check.</p>
      </footer>
    </main>
  );
}
