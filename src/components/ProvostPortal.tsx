import OfficeClearance from './OfficeClearance';

type Props = {
  fullName: string;
  email: string | null;
  hasProvostRole: boolean;
  onSignOut: () => void;
};

export default function ProvostPortal({ fullName, email, hasProvostRole, onSignOut }: Props) {
  return (
    <main className="dashboard-layout">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark small">COHT</div>
          <span>Digital Clearance · Provost</span>
        </div>
        <div className="directory-actions">
          <a className="secondary-button" href="/">Staff workspace</a>
          <button className="secondary-button" type="button" onClick={onSignOut}>Sign out</button>
        </div>
      </header>
      {!hasProvostRole ? (
        <section className="panel">
          <p className="eyebrow dark">ACCESS RESTRICTED</p>
          <h1>Provost access required</h1>
          <p className="muted">This account does not have an active Provost role. Sign in with an authorised Provost account or return to the staff workspace.</p>
          <a className="secondary-button" href="/">Return to staff workspace</a>
        </section>
      ) : (
        <>
          <section className="welcome-block">
            <p className="eyebrow dark">FINAL APPROVAL WORKSPACE</p>
            <h1>Welcome, {fullName}</h1>
            <p className="muted">Review completed office clearances, record Final Assent decisions, and monitor completed student clearances.</p>
          </section>
          <footer className="dashboard-account-footer" aria-label="Provost account status and permissions">
            <div><strong>Account status:</strong> Authenticated <span className="footer-separator">·</span> <strong>Officer:</strong> {fullName} <span className="footer-separator">·</span> <strong>Email:</strong> {email || 'Not set'} <span className="footer-separator">·</span> <strong>Authority:</strong> Final Assent decisions</div>
            <div><strong>Permission rule:</strong> Final Assent is available only when all enabled, required clearance items are cleared. Decisions are validated and recorded by the server with the signed-in officer and timestamp.</div>
            <p className="field-note">A declined student can be reviewed again after outstanding issues are resolved.</p>
          </footer>
          <OfficeClearance roles={['provost']} />
        </>
      )}
      <p className="dashboard-footnote">Restricted Provost workspace · Decisions are authorised and validated by the server.</p>
    </main>
  );
}
