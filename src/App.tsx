import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { envReady, supabase } from './supabase';
import { describeFunctionError } from './functionErrors';
import InstitutionalSetup from './components/InstitutionalSetup';
import StudentPortal from './components/StudentPortal';
import StudentImport from './components/StudentImport';
import StudentAccessTools from './components/StudentAccessTools';

type StaffProfile = { user_id: string; full_name: string; email: string | null; staff_number: string | null; active: boolean; created_at?: string };
type RoleAssignment = { role: string; office_id: string | null; active: boolean; office_name?: string | null };
type StaffContext = { profile: StaffProfile; roles: RoleAssignment[] };
type Office = { id: string; code: string; name: string; active: boolean };
type StaffStatus = 'active' | 'invited' | 'inactive' | 'missing';
type StaffRow = StaffProfile & { roles: RoleAssignment[]; status: StaffStatus; invited_at: string | null; email_confirmed_at: string | null };

const roleLabels: Record<string, string> = {
  superadmin: 'Super Administrator', admin: 'Administrator', clearance_officer: 'Clearance Officer',
  unit_head: 'Unit Head', registrar: 'Registrar', provost: 'Provost', certification_officer: 'Certification Officer',
};
const statusLabels: Record<StaffStatus, string> = { active: 'Active', invited: 'Invited', inactive: 'Inactive', missing: 'Login missing' };
const assignableRoles = [{ value: 'admin', label: 'Administrator' }];

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
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNumber, setInviteNumber] = useState('');
  const [inviteRole, setInviteRole] = useState('admin');
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
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
  const isAcceptRoute = currentPath === '/accept-invite';
  const isStudentRoute = currentPath === '/student';

  const loadStaffContext = useCallback(async (currentSession: Session) => {
    setBusy(true); setError('');
    const userId = currentSession.user.id;
    const { data: profile, error: profileError } = await supabase.from('staff_profiles').select('user_id, full_name, email, staff_number, active').eq('user_id', userId).maybeSingle();
    if (profileError || !profile || !profile.active) {
      await supabase.auth.signOut(); setSession(null); setStaff(null);
      setError('This account is not an active staff account. Contact the platform SuperAdmin.'); setBusy(false); return;
    }
    const { data: assignments, error: roleError } = await supabase.from('staff_role_assignments').select('role, office_id, active').eq('user_id', userId).eq('active', true);
    if (roleError || !assignments || assignments.length === 0) {
      await supabase.auth.signOut(); setSession(null); setStaff(null);
      setError('This account has no active platform role. Contact the platform SuperAdmin.'); setBusy(false); return;
    }
    setSession(currentSession); setStaff({ profile: profile as StaffProfile, roles: assignments as RoleAssignment[] }); setBusy(false);
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
    const paymentReturn = query.get('payment');
    const reference = query.get('reference') || query.get('trxref');
    if (paymentReturn !== 'success' || !reference) return;
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
    setStaffRows((data?.staff ?? []) as StaffRow[]); setOffices((data?.offices ?? []) as Office[]);
  }, [session, isSuperAdmin]);

  useEffect(() => {
    if (isSuperAdmin) void loadStaffList();
  }, [isSuperAdmin, loadStaffList]);

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envReady) { setError('Setup is incomplete. Add the Supabase project URL and public anon key to .env.local.'); return; }
    setSubmitting(true); setError(''); setNotice('');
    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
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
    const needsOffice = inviteRole === 'clearance_officer' || inviteRole === 'unit_head';
    const { data, error: invokeError } = await supabase.functions.invoke('invite-staff', { body: {
      full_name: inviteName.trim(), email: inviteEmail.trim(), staff_number: inviteNumber.trim() || null,
      role: inviteRole, office_id: needsOffice ? (inviteOffice || null) : null,
    } });
    setInviteBusy(false);
    if (invokeError || data?.error || !data?.success) {
      const message = invokeError
        ? await describeFunctionError(invokeError, 'invite-staff', 'Staff invitation failed.')
        : (typeof data?.error === 'string' ? data.error : 'Staff invitation failed.');
      setStaffError(message);
      return;
    }
    setNotice(`Invitation sent to ${inviteEmail.trim()}. Ask the staff member to check their inbox.`);
    setInviteName(''); setInviteEmail(''); setInviteNumber(''); setInviteRole('clearance_officer'); setInviteOffice('');
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

  if (isAcceptRoute) {
    return <main className="auth-layout"><section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Set up your staff access.</h1><p>Choose a strong password to activate your invited staff account.</p></div><p className="panel-footnote">Authorised personnel only · Activity may be audited</p></section><section className="form-panel"><form className="login-card" onSubmit={handleAcceptInvite}><p className="eyebrow dark">STAFF INVITATION</p><h2>Complete your account</h2><p className="muted">Use at least 8 characters. Keep your password private.</p>{!session && <div className="alert warning">No active invitation session was found. Open the newest invitation link from your email.</div>}{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="new-password">New password</label><input id="new-password" type="password" autoComplete="new-password" value={invitePassword} onChange={(e) => setInvitePassword(e.target.value)} minLength={8} required /><label htmlFor="confirm-password">Confirm password</label><input id="confirm-password" type="password" autoComplete="new-password" value={invitePasswordConfirm} onChange={(e) => setInvitePasswordConfirm(e.target.value)} minLength={8} required /><button className="primary-button" type="submit" disabled={acceptBusy || !session}>{acceptBusy ? 'Saving password...' : 'Set password and continue'}<span aria-hidden="true">→</span></button><button className="text-button" type="button" onClick={() => { window.location.href = '/'; }}>Back to staff sign in</button></form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section></main>;
  }

  if (!session || !staff) {
    return <main className="auth-layout"><section className="brand-panel"><div className="brand-lockup"><div className="brand-mark">COHT</div><span>Digital Clearance</span></div><div className="brand-copy"><p className="eyebrow">TARABA STATE COLLEGE OF HEALTH TECHNOLOGY, TAKUM</p><h1>Clearance, without the paperwork.</h1><p>A secure staff portal for managing final-year student clearance and institutional approvals.</p></div><p className="panel-footnote">Authorised personnel only · Activity may be audited</p></section><section className="form-panel"><form className="login-card" onSubmit={handleSignIn}><p className="eyebrow dark">STAFF PORTAL</p><h2>Welcome back</h2><p className="muted">Sign in with your assigned staff account.</p>{!envReady && <div className="alert warning">Supabase configuration is missing. Set up <code>.env.local</code> before signing in.</div>}{error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}<label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="staff@college.edu.ng" required /><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required /><button className="primary-button" type="submit" disabled={submitting || !envReady}>{submitting ? 'Signing in...' : 'Sign in securely'}<span aria-hidden="true">→</span></button><p className="security-note"><span className="shield">✓</span> No public registration. Staff accounts are provisioned by authorised administrators.</p><p className="security-note">Student? <a href="/student">Open the student portal</a>.</p></form><footer className="page-footer">COHT Digital Student Clearance Platform</footer></section></main>;
  }

  return <main className="dashboard-layout"><header className="topbar"><div className="brand-lockup"><div className="brand-mark small">COHT</div><span>Digital Clearance</span></div><button className="secondary-button" onClick={handleSignOut}>Sign out</button></header><section className="welcome-block"><p className="eyebrow dark">STAFF WORKSPACE</p><h1>Welcome, {staff.profile.full_name}</h1><p className="muted">Your account is authenticated and your active role assignment has been loaded.</p></section>{activeRoles.some((item) => item.role === 'provost') && <p><a className="secondary-button" href="/provost">Open dedicated Provost portal</a></p>}{error && <div className="alert error dashboard-alert" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
    <section className="content-grid"><article className="panel account-panel"><div className="panel-heading"><div><p className="eyebrow dark">ACCOUNT STATUS</p><h2>Staff profile</h2></div><span className="status-pill"><span /> Active</span></div><dl className="details-list"><div><dt>Full name</dt><dd>{staff.profile.full_name}</dd></div><div><dt>Email</dt><dd>{staff.profile.email || session.user.email || 'Not set'}</dd></div><div><dt>Staff number</dt><dd>{staff.profile.staff_number || 'Not assigned'}</dd></div><div><dt>Account ID</dt><dd className="uuid">{staff.profile.user_id}</dd></div></dl></article><article className="panel roles-panel"><div className="panel-heading"><div><p className="eyebrow dark">PERMISSIONS</p><h2>Your active roles</h2></div><span className="role-count">{activeRoles.length}</span></div><div className="role-list">{activeRoles.map((item) => <div className="role-item" key={`${item.role}-${item.office_id ?? 'global'}`}><span className="role-icon">✓</span><div><strong>{roleLabels[item.role] ?? item.role}</strong><small>{item.office_id ? `Office assignment · ${item.office_id}` : 'Platform-wide role assignment'}</small></div><span className="role-active">Active</span></div>)}</div><div className="next-step-note"><strong>{isSuperAdmin ? 'SuperAdmin controls enabled' : 'Restricted staff workspace'}</strong><p>{isSuperAdmin ? 'You can invite staff, manage roles, deactivate accounts, and permanently delete staff records. Every change is checked by server-side authorization and audited.' : 'Your workspace is limited to the permissions assigned to your account.'}</p></div></article></section>
    {isSuperAdmin && <InstitutionalSetup />}
    {isSuperAdmin && <StudentImport />}
    {(activeRoles.some((item) => item.role === 'admin') || isSuperAdmin) && <StudentAccessTools canManageStudents={activeRoles.some((item) => item.role === 'admin') && !isSuperAdmin} canManageSupport={isSuperAdmin} />}
    {isSuperAdmin && <section className="management-section"><div className="section-title"><div><p className="eyebrow dark">PLATFORM ADMINISTRATION</p><h2>Staff management</h2><p className="muted">Invite authorised staff and manage account access. SuperAdmin assignment is intentionally excluded from this form.</p></div><button className="secondary-button" onClick={() => void loadStaffList()} disabled={staffLoading}>{staffLoading ? 'Refreshing...' : 'Refresh list'}</button></div>
      {staffError && <div className="alert error" role="alert">{staffError}</div>}
      <div className="management-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow dark">NEW ACCOUNT</p><h2>Invite a staff member</h2></div></div><form className="management-form" onSubmit={handleInvite}><label htmlFor="invite-name">Full name</label><input id="invite-name" value={inviteName} onChange={(e) => setInviteName(e.target.value)} maxLength={160} required /><label htmlFor="invite-email">Email address</label><input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required /><label htmlFor="invite-number">Staff number <span className="optional">Optional</span></label><input id="invite-number" value={inviteNumber} onChange={(e) => setInviteNumber(e.target.value)} maxLength={80} /><label htmlFor="invite-role">Role</label><select id="invite-role" value={inviteRole} onChange={(e) => { setInviteRole(e.target.value); setInviteOffice(''); }} required>{assignableRoles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select>{(inviteRole === 'clearance_officer' || inviteRole === 'unit_head') && <><label htmlFor="invite-office">Clearance office</label><select id="invite-office" value={inviteOffice} onChange={(e) => setInviteOffice(e.target.value)} disabled={staffLoading} required><option value="">Select an active office</option>{offices.filter((office) => office.active).map((office) => <option key={office.id} value={office.id}>{office.name} ({office.code})</option>)}</select>{staffLoading && offices.length === 0 ? <p className="field-note">Loading active offices...</p> : offices.filter((office) => office.active).length === 0 && <p className="field-note">No active offices were returned. Add/configure offices before inviting office-scoped staff.</p>}</>}<button className="primary-button" type="submit" disabled={inviteBusy || (['clearance_officer','unit_head'].includes(inviteRole) && !inviteOffice)}>{inviteBusy ? 'Sending invitation...' : 'Send staff invitation'}<span aria-hidden="true">→</span></button><p className="field-note">An invitation email is sent. The recipient sets their password on the secure acceptance page.</p></form></article>
      <article className="panel staff-directory"><div className="panel-heading"><div><p className="eyebrow dark">CURRENT ACCOUNTS</p><h2>Staff directory</h2></div><span className="role-count">{staffRows.length}</span></div>{staffLoading ? <p className="muted">Loading staff directory...</p> : staffRows.length === 0 ? <p className="muted">No staff records returned.</p> : <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Staff member</th><th>Role / office</th><th>Status</th><th>Action</th></tr></thead><tbody>{staffRows.map((row) => <tr key={row.user_id}><td><strong>{row.full_name}</strong><small>{row.email || 'No email'}{row.staff_number ? ` · ${row.staff_number}` : ''}</small></td><td>{row.roles.filter((r) => r.active).map((r, i) => <span className="staff-role-chip" key={`${r.role}-${r.office_id}-${i}`}>{roleLabels[r.role] ?? r.role}{r.office_name ? ` · ${r.office_name}` : ''}</span>)}</td><td><span className={`directory-status ${row.status}`}>{statusLabels[row.status]}</span></td><td><div className="directory-actions">{row.user_id === session.user.id ? <small className="muted">Current account</small> : <>{row.status !== 'missing' && row.status !== 'inactive' && <button className="danger-button" onClick={() => setTargetToDeactivate(row)} disabled={Boolean(deletingId)}>Deactivate</button>}<button className="danger-button" onClick={() => setTargetToDelete(row)} disabled={Boolean(deletingId)}>Delete</button></>}</div></td></tr>)}</tbody></table></div>}<p className="field-note">Deactivation blocks sign-in and disables the profile and all active roles. Deleting a staff account permanently removes its Auth login, staff profile, and role assignments, frees the email for a new invitation, and retains completed clearance and audit history. Both actions are audited.</p></article></div></section>}
    <p className="dashboard-footnote">Restricted staff workspace · Browser clients do not perform direct database writes.</p>
    {targetToDeactivate && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="deactivate-title"><p className="eyebrow dark">CONFIRM ACCOUNT CHANGE</p><h2 id="deactivate-title">Deactivate {targetToDeactivate.full_name}?</h2><p>This blocks the account from signing in and disables every active role assignment. This action is audited.</p><label htmlFor="deactivation-reason">Reason <span className="optional">Optional</span></label><textarea id="deactivation-reason" value={deactivationReason} onChange={(e) => setDeactivationReason(e.target.value)} maxLength={500} rows={3} placeholder="Reason for the audit record"/><div className="modal-actions"><button className="secondary-button" onClick={() => { setTargetToDeactivate(null); setDeactivationReason(''); }} disabled={Boolean(deactivatingId)}>Cancel</button><button className="danger-button solid" onClick={() => void confirmDeactivation()} disabled={Boolean(deactivatingId)}>{deactivatingId ? 'Deactivating...' : 'Confirm deactivation'}</button></div></section></div>}
    {targetToDelete && <div className="modal-backdrop" role="presentation"><section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><p className="eyebrow dark">PERMANENT ACCOUNT DELETION</p><h2 id="delete-title">Delete {targetToDelete.full_name}?</h2><p>This permanently removes the Auth login, staff profile, and role assignments for <strong>{targetToDelete.email || targetToDelete.full_name}</strong>. The email becomes available for a new invitation. Completed clearance records and audit history are retained.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setTargetToDelete(null)} disabled={Boolean(deletingId)}>Cancel</button><button className="danger-button solid" onClick={() => void confirmDelete()} disabled={Boolean(deletingId)}>{deletingId ? 'Deleting...' : 'Delete permanently'}</button></div></section></div>}
  </main>;
}


