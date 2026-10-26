import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { envReady, supabase } from './supabase';
import { describeFunctionError } from './functionErrors';
import InstitutionalSetup from './components/InstitutionalSetup';
import ClearanceRequirements from './components/ClearanceRequirements';
import OfficeClearance from './components/OfficeClearance';
import ProvostPortal from './components/ProvostPortal';
import StudentPortal from './components/StudentPortal';
import StudentImport from './components/StudentImport';
import StudentAccessTools from './components/StudentAccessTools';

type StaffProfile = { user_id: string; full_name: string; username?: string | null; email: string | null; staff_number: string | null; must_change_password?: boolean; active: boolean; created_at?: string };
type RoleAssignment = { role: string; office_id: string | null; department_id?: string | null; active: boolean; office_name?: string | null; department_name?: string | null };
type StaffContext = { profile: StaffProfile; roles: RoleAssignment[] };
type Office = { id: string; code: string; name: string; active: boolean };
type Department = { id: string; code: string | null; name: string; active: boolean };
type StaffStatus = 'active' | 'invited' | 'inactive' | 'missing';
type StaffRow = StaffProfile & { roles: RoleAssignment[]; status: StaffStatus; invited_at: string | null; email_confirmed_at: string | null };

const roleLabels: Record<string, string> = {
  superadmin: 'Super Administrator', admin: 'Administrator', clearance_officer: 'Clearance Officer', head_of_department: 'Head of Department',
  registrar: 'Registrar', provost: 'Provost', certification_officer: 'Certification Officer', bursar: 'Bursar',
};
const statusLabels: Record<StaffStatus, string> = { active: 'Active', invited: 'Invited', inactive: 'Inactive', missing: 'Login missing' };
const assignableRoles = [
  { value: 'admin', label: 'Administrator' },
  { value: 'clearance_officer', label: 'Clearance Officer' },
  { value: 'head_of_department', label: 'Head of Department' },
  { value: 'registrar', label: 'Registrar' },
  { value: 'provost', label: 'Provost' },
  { value: 'certification_officer', label: 'Certification Officer' },
  { value: 'bursar', label: 'Bursar' },
];
const assignableOfficeCodes = new Set(['EO', 'LB', 'LAB', 'DU', 'DM', 'SM', 'SAD']);

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [staff, setStaff] = useState<StaffContext | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [staffRows, setStaffRows] = useState<StaffRow[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteDepartment, setInviteDepartment] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [firstPassword, setFirstPassword] = useState('');
  const [firstPasswordConfirm, setFirstPasswordConfirm] = useState('');
  const [inviteNumber, setInviteNumber] = useState('');
  const [inviteRole, setInviteRole] = useState('clearance_officer');
  const [inviteOffice, setInviteOffice] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [invitePassword, setInvitePassword] = useState('');
  const [invitePasswordConfirm, setInvitePasswordConfirm] = useState('');
  const [acceptBusy, setAcceptBusy] = useState(false);
  const [deactivatingId, setDeactivatingId] = useState('');
  const [deactivationReason, setDeactivationReason] = useState('');
  const [targetToDeactivate, setTargetToDeactivate] = useState<StaffRow | null>(null);
  const [targetToDelete, setTargetToDelete] = useState<StaffRow | null>(null);
  const [deletingId, setDeletingId] = useState('');
  const [resettingId, setResettingId] = useState('');
  const [resetActivationResult, setResetActivationResult] = useState<{ userId: string; username: string; code: string } | null>(null);
  const [superAdminSection, setSuperAdminSection] = useState<'activities' | 'institutional' | 'requirements' | 'import' | 'payments' | 'staff'>('activities');
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
  const isAcceptRoute = currentPath === '/accept-invite';
  const isStudentRoute = currentPath === '/student';
  const isProvostRoute = currentPath === '/provost';

  const loadStaffContext = useCallback(async (currentSession: Session) => {
    setBusy(true); setError('');
    const userId = currentSession.user.id;
    const { data: profile, error: profileError } = await supabase.from('staff_profiles').select('user_id, full_name, username, email, staff_number, must_change_password, active').eq('user_id', userId).maybeSingle();
    if (profileError || !profile || !profile.active) {
      await supabase.auth.signOut(); setSession(null); setStaff(null);
      setError('This account is not an active staff account. Contact the platform SuperAdmin.'); setBusy(false); return;
    }
    const { data: assignments, error: roleError } = await supabase.from('staff_role_assignments').select('role, office_id, active').eq('user_id', userId).eq('active', true);
    if (roleError || !assignments || assignments.length === 0) {
      await supabase.auth.signOut(); setSession(null); setStaff(null);
      setError('This account has no active platform role. Contact the platform SuperAdmin.'); setBusy(false); return;
    }
    setSession(currentSession); setStaff({ profile: profile as StaffProfile, roles: assignments as RoleAssignment[] }); setMustChangePassword(Boolean((profile as StaffProfile).must_change_password)); setBusy(false);
  }, []);

  useEffect(() => {
    let mounted = true;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      if (!nextSession) { setSession(null); setStaff(null); setBusy(false); return; }
      // Invitation and student sessions must remain on their dedicated routes.
      if (isAcceptRoute || isStudentRoute) { setSession(nextSession); setBusy(false); return; }
      window.setTimeout(() => { if (mounted) void loadStaffContext(nextSession); }, 0);
    });
    const restoreSession = async () => {
      // PKCE invitation links return a one-time authorization code in the query string.
      // Exchange it before checking stored sessions, otherwise the password button stays disabled.
      const query = new URLSearchParams(window.location.search);
      const authCode = query.get('code');
      if (isAcceptRoute && authCode) {
        const { data, error: codeExchangeError } = await supabase.auth.exchangeCodeForSession(authCode);
        if (!mounted) return;
        if (codeExchangeError || !data.session) {
          setError('This invitation link is invalid or expired. Ask the SuperAdmin to send a new invitation.');
          setBusy(false);
          return;
        }
        window.history.replaceState(null, '', window.location.pathname);
        setSession(data.session);
        setBusy(false);
        return;
      }

      // Supabase invitation emails may also return implicit-flow tokens in the URL fragment.
      const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const accessToken = fragment.get('access_token');
      const refreshToken = fragment.get('refresh_token');
      if (isAcceptRoute && fragment.get('type') === 'invite' && accessToken && refreshToken) {
        const { data, error: inviteSessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (!mounted) return;
        if (inviteSessionError || !data.session) {
          setError('This invitation link is invalid or expired. Ask the SuperAdmin to send a new invitation.');
          setBusy(false);
          return;
        }
        // Remove sensitive tokens from the address bar after storing the session.
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        setSession(data.session);
        setBusy(false);
        return;
      }
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!mounted) return;
      if (sessionError) setError('Unable to restore your session. Please sign in again.');
      if (data.session) {
        if (isAcceptRoute || isStudentRoute) { setSession(data.session); setBusy(false); }
        else void loadStaffContext(data.session);
      } else setBusy(false);
    };
    void restoreSession();
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, [isAcceptRoute, isStudentRoute, loadStaffContext]);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const reference = query.get('reference') || query.get('trxref');
    if (currentPath !== '/' || !reference) return;
    let mounted = true;
    void (async () => {
      const { data, error: verifyError } = await supabase.functions.invoke('student-payments', { body: { action: 'verify', payload: { reference } } });
      if (!mounted) return;
      if (verifyError || data?.error || !data?.success) {
        setError(verifyError ? await describeFunctionError(verifyError, 'student-payments', 'Payment return could not be verified.') : String(data?.error || 'Payment could not be verified. Check the student payment record before retrying.'));
      } else {
        setNotice('Payment succeeded and was verified. You have been returned to the admin dashboard. The student can now enter their registration number in the Student Portal to create a password.');
      }
      window.history.replaceState(null, '', window.location.pathname);
    })();
    return () => { mounted = false; };
  }, []);

  const isSuperAdmin = staff?.roles.some((item) => item.active && item.role === 'superadmin') ?? false;
  const loadStaffList = useCallback(async () => {
    if (!session || !isSuperAdmin) return;
    setStaffLoading(true); setStaffError('');
    const { data, error: invokeError } = await supabase.functions.invoke('list-staff', { body: {} });
    setStaffLoading(false);
    if (invokeError) { setStaffError(await describeFunctionError(invokeError, 'list-staff', 'Could not load staff records.')); return; }
    if (data?.error) { setStaffError(String(data.error)); return; }
    setStaffRows((data?.staff ?? []) as StaffRow[]); setOffices((data?.offices ?? []) as Office[]); setDepartments((data?.departments ?? []) as Department[]);
  }, [session, isSuperAdmin]);

  useEffect(() => {
    if (isSuperAdmin) void loadStaffList();
  }, [isSuperAdmin, loadStaffList]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envReady) { setError('Setup is incomplete. Add the Supabase project URL and public anon key to .env.local.'); return; }
    setSubmitting(true); setError(''); setNotice('');
    const identifier = email.trim().toLowerCase();
    const loginEmail = identifier.includes('@') ? identifier : `${identifier}@staff.dscp.invalid`;
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: loginEmail, password });
    setSubmitting(false);
    if (signInError) { setError('Sign-in failed. Check the email and password, then try again.'); return; }
    if (data.session) await loadStaffContext(data.session);
  }

  async function handleSignOut() {
    setError(''); const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError('Could not sign out cleanly. Please retry.');
    else { setStaff(null); setSession(null); setPassword(''); setNotice('You have signed out.'); if (isAcceptRoute) window.location.href = '/'; }
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setInviteBusy(true); setStaffError(''); setNotice('');
    const selectedOffice = inviteRole === 'head_of_department'
      ? offices.find((office) => office.active && office.code === 'HOD')
      : offices.find((office) => office.id === inviteOffice);
    const needsOffice = inviteRole === 'clearance_officer' || inviteRole === 'head_of_department';
    const needsDepartment = inviteRole === 'head_of_department';
    const { data, error: invokeError } = await supabase.functions.invoke('invite-staff', { body: {
      full_name: inviteName.trim(), username: inviteUsername.trim().toLowerCase(), staff_number: inviteNumber.trim() || null,
      role: inviteRole, office_id: needsOffice ? (selectedOffice?.id || null) : null, department_id: needsDepartment ? (inviteDepartment || null) : null,
    } });
    setInviteBusy(false);
    if (invokeError || data?.error || !data?.success) {
      const message = invokeError
        ? await describeFunctionError(invokeError, 'invite-staff', 'Staff invitation failed.')
        : (typeof data?.error === 'string' ? data.error : 'Staff invitation failed.');
      setStaffError(message);
      return;
    }
    setActivationCode(String(data.activation_code ?? ''));
    setNotice(`Staff account created for ${inviteUsername.trim()}. Give the activation code to the officer securely; it is shown only once.`);
    setInviteName(''); setInviteUsername(''); setInviteNumber(''); setInviteRole('clearance_officer'); setInviteOffice(''); setInviteDepartment('');
    await loadStaffList();
  }

  async function confirmDeactivation() {
    if (!targetToDeactivate) return;
    setDeactivatingId(targetToDeactivate.user_id); setStaffError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('deactivate-staff', { body: { target_user_id: targetToDeactivate.user_id, reason: deactivationReason.trim() || null } });
    setDeactivatingId('');
    if (invokeError || data?.error || !data?.success) {
      const message = invokeError
        ? await describeFunctionError(invokeError, 'deactivate-staff', 'Deactivation failed.')
        : (typeof data?.error === 'string' ? data.error : 'Deactivation failed.');
      setStaffError(message);
      return;
    }
    setNotice(`Staff account for ${targetToDeactivate.full_name} has been deactivated.`); setTargetToDeactivate(null); setDeactivationReason(''); await loadStaffList();
  }

  async function confirmDelete() {
    if (!targetToDelete || deletingId) return;
    setDeletingId(targetToDelete.user_id); setStaffError(''); setNotice('');
    const { data, error: invokeError } = await supabase.functions.invoke('delete-staff', { body: { target_user_id: targetToDelete.user_id } });
    setDeletingId('');
    if (invokeError || data?.error || !data?.success) {
      const message = invokeError
        ? await describeFunctionError(invokeError, 'delete-staff', 'Staff deletion failed.')
        : (typeof data?.error === 'string' ? data.error : 'Staff deletion failed.');
      setStaffError(message);
      return;
    }
    const emailNote = targetToDelete.email ? ` ${targetToDelete.email} can now be invited again.` : ' The email can now be invited again.';
    setNotice(`Staff account for ${targetToDelete.full_name} has been deleted.${emailNote}`);
    setTargetToDelete(null);
    await loadStaffList();
  }

  async function generateNewActivationCode(target: StaffRow) {
    if (resettingId) return;
    setResettingId(target.user_id); setStaffError(''); setNotice(''); setResetActivationResult(null);
    const { data, error: invokeError } = await supabase.functions.invoke('reset-staff-activation-code', { body: { target_user_id: target.user_id } });
    setResettingId('');
    if (invokeError || data?.error || !data?.success || !data?.activation_code) {
      const message = invokeError
        ? await describeFunctionError(invokeError, 'reset-staff-activation-code', 'Could not generate a new activation code.')
        : (typeof data?.error === 'string' ? data.error : 'Could not generate a new activation code.');
      setStaffError(message);
      return;
    }
    setResetActivationResult({ userId: target.user_id, username: target.username || target.full_name, code: String(data.activation_code) });
    setNotice('A new activation code was generated for ' + target.full_name + '. Their previous password is no longer valid; they must set a new password after signing in.');
    await loadStaffList();
  }
  async function handleFirstPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('');
    if (firstPassword.length < 8) { setError('Use at least 8 characters for your new password.'); return; }
    if (firstPassword !== firstPasswordConfirm) { setError('The passwords do not match.'); return; }
    setAcceptBusy(true);
    const { data, error: completeError } = await supabase.functions.invoke('complete-staff-setup', { body: { new_password: firstPassword } });
    setAcceptBusy(false);
    if (completeError || data?.error || !data?.success) { setError('Password change could not be finalized. Sign in again or contact SuperAdmin.'); return; }

    // complete-staff-setup changes the Auth password through the Admin API, which
    // invalidates the activation-code session. Clear the stale local session and
    // require a fresh sign-in before loading any protected staff workspace.
    await supabase.auth.signOut({ scope: 'local' });
    setSession(null); setStaff(null); setMustChangePassword(false);
    setPassword(''); setFirstPassword(''); setFirstPasswordConfirm('');
    setNotice('Password changed successfully. Please sign in again with your new password.');
  }

  async function handleAcceptInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setNotice('');
    if (!session) { setError('Invitation session is missing or expired. Reopen the latest invitation email.'); return; }
    if (invitePassword.length < 8) { setError('Use at least 8 characters for your password.'); return; }
    if (invitePassword !== invitePasswordConfirm) { setError('The passwords do not match.'); return; }
    setAcceptBusy(true); const { error: updateError } = await supabase.auth.updateUser({ password: invitePassword }); setAcceptBusy(false);
    if (updateError) { setError(updateError.message); return; }
    setNotice('Password set successfully. Opening your staff workspace...'); window.setTimeout(() => { window.location.href = '/'; }, 900);
  }

  const activeRoles = staff?.roles.filter((item) => item.active) ?? [];
  if (busy) return <main className="loading-screen"><div className="brand-mark">COHT</div><p>Checking secure staff access...</p></main>;

  if (isStudentRoute) return <StudentPortal />;

  if (session && mustChangePassword) {
    return <main className="auth-layout"><section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">SECURE STAFF ACCESS</p><h1>Set your new password.</h1><p>Your activation code is temporary. Change it before continuing to your workspace.</p></div></section><section className="form-panel"><form className="login-card" onSubmit={handleFirstPasswordChange}><p className="eyebrow dark">FIRST LOGIN</p><h2>Change password</h2>{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="first-password">New password</label><input id="first-password" type="password" autoComplete="new-password" value={firstPassword} onChange={(e) => setFirstPassword(e.target.value)} minLength={8} required /><label htmlFor="first-password-confirm">Confirm new password</label><input id="first-password-confirm" type="password" autoComplete="new-password" value={firstPasswordConfirm} onChange={(e) => setFirstPasswordConfirm(e.target.value)} minLength={8} required /><button className="primary-button" type="submit" disabled={acceptBusy}>{acceptBusy ? 'Updating password...' : 'Change password and continue'}<span aria-hidden="true">→</span></button></form></section></main>;
  }

  if (isAcceptRoute) {
    return <main className="auth-layout"><section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Set up your staff access.</h1><p>Choose a strong password to activate your invited staff account.</p></div><p className="panel-footnote">Authorised personnel only · Activity may be audited</p></section><section className="form-panel"><form className="login-card" onSubmit={handleAcceptInvite}><p className="eyebrow dark">STAFF INVITATION</p><h2>Complete your account</h2><p className="muted">Use at least 8 characters. Keep your password private.</p>{!session && <div className="alert warning">No active invitation session was found. Open the newest invitation link from your email.</div>}{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} minLength={8} required /><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" type="password" autoComplete="new-password" value={invitePasswordConfirm} onChange={(e) => setInvitePasswordConfirm(e.target.value)} minLength={8} required /><button className="primary-button" type="submit" disabled={acceptBusy || !session}>{acceptBusy ? 'Saving password...' : 'Set password and continue'}<span aria-hidden="true">→</span></button><button className="text-button" type="button" onClick={() => { window.location.href = '/'; }}>Back to staff sign in</button></form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section></main>;
  }

  if (!session || !staff) {
    return <main className="auth-layout"><section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Clearance, without the paperwork.</h1><p>A secure staff portal for managing final-year student clearance and institutional approvals.</p></div><p className="panel-footnote">Authorised personnel only · Activity may be audited</p></section><section className="form-panel"><form className="login-card" onSubmit={handleSignIn}><p className="eyebrow dark">STAFF PORTAL</p><h2>Welcome back</h2><p className="muted">Sign in with your assigned staff account.</p>{!envReady && <div className="alert warning">Supabase configuration is missing. Set up <code>.env.local</code> before signing in.</div>}{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="email">Username or email</label><input id="email" type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Enter your username" required /><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required /><button className="primary-button" type="submit" disabled={submitting || !envReady}>{submitting ? 'Signing in...' : 'Sign in securely'}<span aria-hidden="true">→</span></button><p className="security-note"><span className="shield">✓</span> No public registration. Staff accounts are provisioned by authorised administrators.</p><p className="security-note">Student? <a href="/student">Open the student portal</a>.</p></form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section></main>;
  }

  if (isProvostRoute) return <ProvostPortal fullName={staff.profile.full_name} email={staff.profile.email || session.user.email || null} hasProvostRole={activeRoles.some((item) => item.role === 'provost')} onSignOut={() => void handleSignOut()} />;

  return <main className="dashboard-layout"><header className="topbar"><div className="brand-lockup"><div className="brand-mark small">COHT</div><span>Digital Clearance</span></div><button className="secondary-button" onClick={handleSignOut}>Sign out</button></header><section className="welcome-block"><p className="eyebrow dark">STAFF WORKSPACE</p><h1>Welcome, {staff.profile.full_name}</h1><p className="muted">Your account is authenticated and your active role assignment has been loaded.</p></section>{activeRoles.some((item) => item.role === 'provost') && <p><a className="secondary-button" href="/provost">Open dedicated Provost portal</a></p>}{error && <div className="alert error dashboard-alert" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
    {isSuperAdmin && <nav className="superadmin-nav" aria-label="SuperAdmin dashboard sections">
      {([
        ['activities', 'Activities'],
        ['institutional', 'Institutional setup'],
        ['requirements', 'Clearance requirements'],
        ['import', 'Import student records'],
        ['payments', 'Student payment and account assistance'],
        ['staff', 'Staff management'],
      ] as const).map(([section, label]) => <button key={section} type="button" className={`superadmin-nav-pill${superAdminSection === section ? ' active' : ''}`} aria-current={superAdminSection === section ? 'page' : undefined} onClick={() => setSuperAdminSection(section)}>{label}</button>)}
    </nav>}
    {isSuperAdmin && superAdminSection === 'activities' && <section className="superadmin-activities"><p className="eyebrow dark">SUPERADMIN DASHBOARD</p><h2>Activities</h2><p className="muted">The Activities section will be defined later.</p></section>}
    {!isSuperAdmin && !activeRoles.some((item) => item.role === 'admin') && activeRoles.some((item) => ['clearance_officer','head_of_department','bursar','provost','registrar'].includes(item.role)) && <OfficeClearance roles={activeRoles.map((item) => item.role)} />}
    {isSuperAdmin && superAdminSection === 'institutional' && <InstitutionalSetup />}
    {isSuperAdmin && superAdminSection === 'requirements' && <ClearanceRequirements />}
    {isSuperAdmin && superAdminSection === 'import' && <StudentImport />}
    {((!isSuperAdmin && activeRoles.some((item) => item.role === 'admin')) || (isSuperAdmin && superAdminSection === 'payments')) && <StudentAccessTools canManageStudents={activeRoles.some((item) => item.role === 'admin') && !isSuperAdmin} canManageSupport={isSuperAdmin} />}
    {isSuperAdmin && superAdminSection === 'staff' && <section className="management-section"><div className="section-title"><div><p className="eyebrow dark">PLATFORM ADMINISTRATION</p><h2>Staff management</h2><p className="muted">Invite authorised staff and manage account access. SuperAdmin assignment is intentionally excluded from this form.</p></div><button className="secondary-button" onClick={() => void loadStaffList()} disabled={staffLoading}>{staffLoading ? 'Refreshing...' : 'Refresh list'}</button></div>
      {staffError && <div className="alert error" role="alert">{staffError}</div>}
      <div className="management-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">NEW ACCOUNT</p><h2>Create staff account</h2></div></div><form className="management-form" onSubmit={handleInvite}><label htmlFor="invite-name">Full name</label><input id="invite-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} maxLength={160} required /><label htmlFor="invite-username">Username</label><input id="invite-username" value={inviteUsername} onChange={(e) => setInviteUsername(e.target.value)} minLength={3} maxLength={40} pattern="[A-Za-z0-9._-]+" autoComplete="off" required /><label htmlFor="invite-number">Staff number <span className="optional">Optional</span></label><input id="invite-number" value={inviteNumber} onChange={(e) => setInviteNumber(e.target.value)} maxLength={80} /><label htmlFor="invite-role">Role</label><select id="invite-role" value={inviteRole} onChange={(e) => { setInviteRole(e.target.value); setInviteOffice(''); setInviteDepartment(''); }} required>{assignableRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select>{inviteRole === 'clearance_officer' && <><label htmlFor="invite-office">Clearance office</label><select id="invite-office" value={inviteOffice} onChange={(e) => { setInviteOffice(e.target.value); setInviteDepartment(''); }} disabled={staffLoading} required><option value="">Select an office</option>{offices.filter((office) => office.active && assignableOfficeCodes.has(office.code)).map((office) => <option key={office.id} value={office.id}>{office.name} ({office.code})</option>)}</select>{staffLoading && offices.length === 0 ? <p className="field-note">Loading active offices...</p> : offices.filter((office) => office.active && assignableOfficeCodes.has(office.code)).length === 0 && <p className="field-note">No eligible active clearance offices were returned. Configure EO, LB, LAB, DU, DM, SM, or SAD first.</p>}</>}{inviteRole === 'head_of_department' && <><label htmlFor="invite-department">Department</label><select id="invite-department" value={inviteDepartment} onChange={(e) => setInviteDepartment(e.target.value)} disabled={staffLoading} required><option value="">Select department</option>{departments.filter((department) => department.active).map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select><p className="field-note">HOD access is limited to requests from this department.</p>{!offices.some((office) => office.active && office.code === 'HOD') && <p className="field-note">The active HOD clearance office is not configured. Configure it before creating an HOD account.</p>}</>}<button className="primary-button" type="submit" disabled={inviteBusy || (inviteRole === 'clearance_officer' && (!inviteOffice || !assignableOfficeCodes.has(offices.find((office) => office.id === inviteOffice)?.code ?? ''))) || (inviteRole === 'head_of_department' && (!inviteDepartment || !offices.some((office) => office.active && office.code === 'HOD')))}>{inviteBusy ? 'Creating account...' : 'Create account'}<span aria-hidden="true">→</span></button><p className="field-note">A six-character activation code is generated automatically. The officer must change it to a new password on first login.</p>{activationCode && <div className="alert success"><strong>Activation code (shown once):</strong><p className="uuid">{activationCode}</p><button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(activationCode)}>Copy activation code</button></div>}</form></article>
      <article className="panel staff-directory"><div className="panel-heading"><div><p className="eyebrow dark">CURRENT ACCOUNTS</p><h2>Staff directory</h2></div><span className="role-count">{staffRows.length}</span></div>{resetActivationResult && <div className="alert success"><strong>New activation code for @{resetActivationResult.username} (shown once):</strong><p className="uuid">{resetActivationResult.code}</p><p className="field-note">The old password no longer works. The staff member must sign in with this code and create a new password.</p><button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(resetActivationResult.code)}>Copy activation code</button><button className="text-button" type="button" onClick={() => setResetActivationResult(null)}>Hide code</button></div>}{staffLoading ? <p className="muted">Loading staff directory...</p> : staffRows.length === 0 ? <p className="muted">No staff records returned.</p> : <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Staff member</th><th>Role / office</th><th>Status</th><th>Action</th></tr></thead><tbody>{staffRows.map((row) => <tr key={row.user_id}><td><strong>{row.full_name}</strong><small>{row.username ? `@${row.username}` : (row.email || 'No email')}{row.staff_number ? ` · ${row.staff_number}` : ''}</small></td><td>{row.roles.filter((r) => r.active).map((r, i) => <span className="staff-role-chip" key={`${r.role}-${r.office_id}-${i}`}>{roleLabels[r.role] ?? r.role}{r.office_name ? ` · ${r.office_name}` : ''}{r.department_name ? ` · ${r.department_name}` : ''}</span>)}</td><td><span className={`directory-status ${row.status}`}>{statusLabels[row.status]}</span></td><td><div className="directory-actions">{row.user_id === session.user.id ? <small className="muted">Current account</small> : <>{row.status !== 'missing' && row.status !== 'inactive' && <><button className="secondary-button" onClick={() => void generateNewActivationCode(row)} disabled={Boolean(resettingId) || Boolean(deletingId)}>{resettingId === row.user_id ? 'Generating...' : 'Generate new activation code'}</button><button className="danger-button" onClick={() => setTargetToDeactivate(row)} disabled={Boolean(deletingId) || Boolean(resettingId)}>Deactivate</button></>}<button className="danger-button" onClick={() => setTargetToDelete(row)} disabled={Boolean(deletingId) || Boolean(resettingId)}>Delete</button></>}</div></td></tr>)}</tbody></table></div>}<p className="field-note">Deactivation blocks sign-in and disables the profile and all active roles. Deleting a staff account permanently removes its Auth login, staff profile, and role assignments, frees the email for a new invitation, and retains completed clearance and audit history. Both actions are audited.</p></article></div></section>}
        <footer className="dashboard-account-footer" aria-label="Account status and permissions">
      <div><strong>Account status:</strong> Active <span className="footer-separator">·</span> <strong>Staff:</strong> {staff.profile.full_name} <span className="footer-separator">·</span> <strong>Username:</strong> {staff.profile.username || staff.profile.email || session.user.email || 'Not set'} <span className="footer-separator">·</span> <strong>Staff number:</strong> {staff.profile.staff_number || 'Not assigned'}</div>
      <div><strong>Account ID:</strong> <span className="uuid">{staff.profile.user_id}</span></div>
      <div><strong>Active permissions:</strong> {activeRoles.map((item, index) => <span key={`${item.role}-${item.office_id ?? 'global'}`}>{index > 0 ? ' · ' : ''}{roleLabels[item.role] ?? item.role}{item.department_name ? ` — Department: ${item.department_name}` : item.office_id ? ` — Office: ${item.office_id}` : ' — Platform-wide'}</span>)}</div>
      <p>{isSuperAdmin ? 'SuperAdmin controls enabled. Staff and platform changes are checked by server-side authorization and audited.' : 'This workspace is limited to the permissions assigned to your account.'}</p>
    </footer>
<p className="dashboard-footnote">Restricted staff workspace · Browser clients do not perform direct database writes.</p>
    {targetToDeactivate && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="deactivate-title"><p className="eyebrow dark">CONFIRM ACCOUNT CHANGE</p><h2 id="deactivate-title">Deactivate {targetToDeactivate.full_name}?</h2><p>This blocks the account from signing in and disables every active role assignment. This action is audited.</p><label htmlFor="deactivation-reason">Reason <span className="optional">Optional</span></label><textarea id="deactivation-reason" value={deactivationReason} onChange={(e) => setDeactivationReason(e.target.value)} maxLength={500} rows={3} placeholder="Reason for the audit record"/><div className="modal-actions"><button className="secondary-button" onClick={() => { setTargetToDeactivate(null); setDeactivationReason(''); }} disabled={Boolean(deactivatingId)}>Cancel</button><button className="danger-button solid" onClick={() => void confirmDeactivation()} disabled={Boolean(deactivatingId)}>{deactivatingId ? 'Deactivating...' : 'Confirm deactivation'}</button></div></section></div>}
    {targetToDelete && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><p className="eyebrow dark">PERMANENT ACCOUNT DELETION</p><h2 id="delete-title">Delete {targetToDelete.full_name}?</h2><p>This permanently removes the Auth login, staff profile, and role assignments for <strong>{targetToDelete.email || targetToDelete.full_name}</strong>. The email becomes available for a new invitation. Completed clearance records and audit history are retained.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setTargetToDelete(null)} disabled={Boolean(deletingId)}>Cancel</button><button className="danger-button solid" onClick={() => void confirmDelete()} disabled={Boolean(deletingId)}>{deletingId ? 'Deleting...' : 'Delete permanently'}</button></div></section></div>}
  </main>;
}


