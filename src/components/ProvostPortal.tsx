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
          <section className="content-grid">
            <article className="panel account-panel">
              <div className="panel-heading"><div><p className="eyebrow dark">SIGNED-IN ACCOUNT</p><h2>Provost profile</h2></div><span className="status-pill"><span /> Authenticated</span></div>
              <dl className="details-list">
                <div><dt>Full name</dt><dd>{fullName}</dd></div>
                <div><dt>Email</dt><dd>{email || 'Not set'}</dd></div>
                <div><dt>Authority</dt><dd>Final Assent decisions</dd></div>
              </dl>
            </article>
            <article className="panel roles-panel">
              <div className="panel-heading"><div><p className="eyebrow dark">DECISION RULE</p><h2>Approval safeguards</h2></div></div>
              <p>Only students whose enabled, required clearance items are all cleared can receive Final Assent. Decisions are recorded with the signed-in officer and timestamp.</p>
              <p className="field-note">A declined student can be reviewed again after outstanding issues are resolved. Granting assent is not available until the server confirms eligibility.</p>
            </article>
          </section>
          <OfficeClearance roles={['provost']} />
        </>
      )}
      <p className="dashboard-footnote">Restricted Provost workspace · Decisions are authorised and validated by the server.</p>
    </main>
  );
}
