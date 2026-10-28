import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';
import { describeFunctionError } from '../functionErrors';

type ClearanceComment = { id: string; comment_text: string; author_role: string; created_at: string };
type BursaryReceipt = { id: string; clearance_request_id: string; student_name: string; registration_number: string; department: string | null; programme: string | null; session_name: string; academic_session: string | null; original_filename: string; mime_type: string; size_bytes: number; uploaded_at: string | null; request_status: string };
type ClearanceRequest = {
  request_id: string;
  session_student_id: string;
  student_name: string;
  registration_number: string;
  department: string | null;
  programme: string | null;
  session_name: string;
  academic_session: string | null;
  office_id: string;
  office_name: string;
  requirement_id: string;
  instructions: string | null;
  status: 'requested' | 'needs_attention' | 'cleared' | string;
  requested_at: string | null;
  decision_at: string | null;
  reminder_count: number;
  comments: ClearanceComment[];
};
type AssentRow = {
  session_student_id: string;
  student_name: string;
  registration_number: string;
  department: string | null;
  programme: string | null;
  session_name: string;
  academic_session: string | null;
  final_assent: string;
  final_assent_remarks: string | null;
};
type NoticeItem = { id: string; title: string; message: string; notification_type: string; created_at: string; read_at: string | null };
type CompletedRow = {
  session_student_id: string;
  student_name: string;
  registration_number: string;
  department: string | null;
  programme: string | null;
  session_name: string;
  academic_session: string | null;
  final_assent_at: string | null;
  completed_at: string | null;
};
type QueueData = {
  requests: ClearanceRequest[];
  assent_queue: AssentRow[];
  completed_queue: CompletedRow[];
  can_configure_reminders: boolean;
  reminder_interval_hours: number;
};

const eligibleRoles = new Set(['admin', 'clearance_officer', 'head_of_department', 'bursar', 'provost', 'registrar']);
const dateText = (value: string | null) => value ? new Date(value).toLocaleString() : '—';

export default function OfficeClearance({ roles }: { roles: string[] }) {
  const relevant = roles.some((role) => eligibleRoles.has(role));
  const isBursar = roles.includes('bursar');
  const isProvost = roles.includes('provost');
  const isRegistrar = roles.includes('registrar');
  const [queue, setQueue] = useState<QueueData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [assentDrafts, setAssentDrafts] = useState<Record<string, string>>({});
  const [intervalHours, setIntervalHours] = useState('24');
  const [notifications, setNotifications] = useState<NoticeItem[]>([]);
  const [bursaryReceipts, setBursaryReceipts] = useState<BursaryReceipt[]>([]);
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({});

  const invoke = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error: invokeError } = await supabase.functions.invoke('manage-clearance', {
      body: { action, payload },
    });
    if (invokeError) throw new Error(await describeFunctionError(invokeError, 'manage-clearance', 'Clearance operation failed.'));
    if (data?.error) throw new Error(String(data.error));
    if (data?.success === false) throw new Error(String(data.error || 'Clearance operation failed.'));
    return data;
  }, []);

  const reload = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    try {
      const data = await invoke('list_queue');
      setQueue({
        requests: Array.isArray(data?.requests) ? data.requests : [],
        assent_queue: Array.isArray(data?.assent_queue) ? data.assent_queue : [],
        completed_queue: Array.isArray(data?.completed_queue) ? data.completed_queue : [],
        can_configure_reminders: Boolean(data?.can_configure_reminders),
        reminder_interval_hours: Number(data?.reminder_interval_hours || 24),
      });
      setIntervalHours(String(data?.reminder_interval_hours || 24));
      if (isBursar) {
        const { data: receiptData, error: receiptError } = await supabase.functions.invoke('bursary-receipts', {
          body: { action: 'list_bursar_receipts' },
        });
        if (!receiptError && !receiptData?.error) setBursaryReceipts(Array.isArray(receiptData?.receipts) ? receiptData.receipts as BursaryReceipt[] : []);
        else setBursaryReceipts([]);
      } else {
        setBursaryReceipts([]);
        setReceiptUrls({});
      }
      const { data: authData } = await supabase.auth.getUser();
      if (authData.user) {
        const { data: noticeRows, error: noticeError } = await supabase
          .from('notifications')
          .select('id,title,message,notification_type,created_at,read_at')
          .eq('recipient_user_id', authData.user.id)
          .order('created_at', { ascending: false })
          .limit(8);
        if (!noticeError) setNotifications((noticeRows ?? []) as NoticeItem[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load clearance queue.');
    } finally {
      setLoading(false);
    }
  }, [invoke, isBursar]);

  useEffect(() => {
    if (!relevant) return;
    void reload();
    // Refresh the office queue when staff return to this tab, so new requests
    // appear without requiring a sign-out or a full page reload.
    const refreshOnFocus = () => { void reload(false); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [relevant, reload]);

  async function perform(key: string, action: string, payload: Record<string, unknown>, successMessage: string) {
    setBusy(key); setError(''); setNotice('');
    try {
      await invoke(action, payload);
      setNotice(successMessage);
      if (action === 'comment') setDrafts((old) => ({ ...old, [String(payload.request_id)]: '' }));
      if (action === 'final_assent') setAssentDrafts((old) => ({ ...old, [String(payload.session_student_id)]: '' }));
      await reload(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The operation failed.');
    } finally {
      setBusy('');
    }
  }

  async function prepareReceiptDownload(receiptId: string) {
    setBusy('receipt-' + receiptId); setError(''); setNotice('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('bursary-receipts', {
        body: { action: 'download_receipt', payload: { receipt_id: receiptId } },
      });
      if (invokeError || data?.error || !data?.url) throw new Error(data?.error || 'Could not open receipt.');
      setReceiptUrls((old) => ({ ...old, [receiptId]: String(data.url) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open receipt.');
    } finally {
      setBusy('');
    }
  }

  async function saveInterval() {
    const hours = Number(intervalHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
      setError('Reminder interval must be a whole number from 1 to 720 hours.');
      return;
    }
    await perform('reminder-setting', 'set_reminder_interval', { interval_hours: hours }, `Reminder interval saved: every ${hours} hour(s).`);
  }

  if (!relevant) return null;

  return (
    <section className="clearance-workspace">
      <div className="section-title">
        <div>
          <p className="eyebrow dark">PHASE 4 · CLEARANCE WORKFLOW</p>
          <h2>Office clearance</h2>
          <p className="muted">Review requests assigned to your office. Adding remarks does not clear a request.</p>
        </div>
        <button className="secondary-button no-print" type="button" onClick={() => void reload()} disabled={loading || Boolean(busy)}>
          {loading ? 'Refreshing…' : 'Refresh queue'}
        </button>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert success" role="status">{notice}</div>}

      {notifications.length > 0 && (
        <article className="panel clearance-notifications">
          <div className="panel-heading"><div><p className="eyebrow dark">IN-APP ALERTS</p><h3>Recent notifications</h3></div><span className="role-count">{notifications.filter((item) => !item.read_at).length}</span></div>
          <div className="clearance-notification-list">
            {notifications.map((item) => <div className="clearance-notification" key={item.id}>
              <strong>{item.title}</strong><p>{item.message}</p><small>{dateText(item.created_at)}{!item.read_at ? ' · Unread' : ''}</small>
            </div>)}
          </div>
        </article>
      )}

      {queue?.can_configure_reminders && (
        <article className="panel reminder-settings no-print">
          <div>
            <p className="eyebrow dark">REMINDER SETTINGS</p>
            <h3>Unresolved request reminders</h3>
            <p className="muted">Reminders are queued for requests that remain uncleared and have no remarks.</p>
          </div>
          <div className="reminder-controls">
            <label htmlFor="reminder-hours">Interval (hours)</label>
            <input id="reminder-hours" type="number" min="1" max="720" step="1" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} />
            <button className="secondary-button" type="button" onClick={() => void saveInterval()} disabled={Boolean(busy)}>Save interval</button>
          </div>
          <p className="field-note">The scheduled reminder worker must be deployed and scheduled before reminders are generated automatically.</p>
        </article>
      )}

      <div className="clearance-section-heading">
        <div><h3>Requests</h3></div>
        <span className="role-count">{queue?.requests.length ?? 0}</span>
      </div>
      {loading ? <p className="muted">Loading clearance queue…</p> : !queue?.requests.length ? (
        <div className="panel"><p className="muted">No requested clearance items are currently visible to your role.</p></div>
      ) : (
        <div className="clearance-request-list">
          {queue.requests.map((item) => (
            <article className="panel clearance-request-card" key={item.request_id}>
              <div className="clearance-card-header">
                <div>
                  <h3>{item.student_name}</h3>
                  <p className="clearance-reg">{item.registration_number}</p>
                </div>
                <span className={`clearance-status status-${item.status}`}>{item.status.replace('_', ' ')}</span>
              </div>
              <div className="clearance-meta">
                <span><strong>Office</strong>{item.office_name}</span>
                <span><strong>Session</strong>{item.academic_session || item.session_name}</span>
                <span><strong>Department / programme</strong>{[item.department, item.programme].filter(Boolean).join(' · ') || '—'}</span>
                <span><strong>Requested</strong>{dateText(item.requested_at)}</span>
              </div>
              {item.instructions && <p className="clearance-instructions">{item.instructions}</p>}
              {roles.includes('bursar') && bursaryReceipts.filter((receipt) => receipt.clearance_request_id === item.request_id).map((receipt) => (
                <div className="bursary-receipt-panel" key={receipt.id}>
                  <h4>Student payment receipt</h4>
                  <div className="clearance-meta">
                    <span><strong>Student</strong>{receipt.student_name}</span>
                    <span><strong>Registration number</strong>{receipt.registration_number}</span>
                    <span><strong>Department / programme</strong>{[receipt.department, receipt.programme].filter(Boolean).join(' · ') || '—'}</span>
                    <span><strong>Session</strong>{receipt.academic_session || receipt.session_name}</span>
                    <span><strong>Uploaded</strong>{dateText(receipt.uploaded_at)}</span>
                    <span><strong>File</strong>{receipt.original_filename} · {(receipt.size_bytes / 1024).toFixed(0)} KB</span>
                  </div>
                  {!receiptUrls[receipt.id] ? <button className="secondary-button no-print" type="button" disabled={Boolean(busy)} onClick={() => void prepareReceiptDownload(receipt.id)}>{busy === 'receipt-' + receipt.id ? 'Preparing secure link…' : 'Open / download receipt'}</button> : <a className="secondary-button" href={receiptUrls[receipt.id]} target="_blank" rel="noreferrer">Open / download receipt</a>}
                  <p className="field-note">Verify the receipt before using the existing clearance decision. Uploading alone does not clear this request.</p>
                </div>
              ))}
              {item.comments.length > 0 && (
                <div className="clearance-comments">
                  <strong>Remarks</strong>
                  {item.comments.map((comment) => (
                    <div className="clearance-comment" key={comment.id}>
                      <p>{comment.comment_text}</p>
                      <small>{comment.author_role.replace('_', ' ')} · {dateText(comment.created_at)}</small>
                    </div>
                  ))}
                </div>
              )}
              {item.status !== 'cleared' && (
                <div className="clearance-actions no-print">
                  <form onSubmit={(e) => { e.preventDefault(); const text = drafts[item.request_id]?.trim(); if (text) void perform(`comment-${item.request_id}`, 'comment', { request_id: item.request_id, comment_text: text }, 'Remark added. The clearance status has not changed.'); }}>
                    <label htmlFor={`remark-${item.request_id}`}>Add remarks (does not clear)</label>
                    <textarea id={`remark-${item.request_id}`} rows={2} maxLength={3000} value={drafts[item.request_id] ?? ''} onChange={(e) => setDrafts((old) => ({ ...old, [item.request_id]: e.target.value }))} placeholder="Record what is missing or what the student should do next." />
                    <button className="secondary-button" type="submit" disabled={Boolean(busy) || !(drafts[item.request_id] ?? '').trim()}>Add remarks</button>
                  </form>
                  <button className="primary-button clearance-clear-button" type="button" onClick={() => void perform(`clear-${item.request_id}`, 'clear', { request_id: item.request_id }, 'Clearance request marked as cleared.')} disabled={Boolean(busy) || !['requested', 'needs_attention'].includes(item.status)}>
                    {busy === `clear-${item.request_id}` ? 'Clearing…' : 'Clear request'}
                  </button>
                </div>
              )}
              {item.status === 'cleared' && <p className="clearance-decision-note">Cleared {dateText(item.decision_at)}</p>}
            </article>
          ))}
        </div>
      )}

      {isProvost && (
        <>
          <div className="clearance-section-heading">
            <div><p className="eyebrow dark">PROVOST APPROVAL</p><h3>Final Assent queue</h3><p className="muted">Only students whose enabled, required clearance items are all cleared appear here.</p></div>
            <span className="role-count">{queue?.assent_queue.length ?? 0}</span>
          </div>
          {!queue?.assent_queue.length ? <div className="panel"><p className="muted">No students are currently ready for Final Assent.</p></div> : (
            <div className="clearance-request-list">
              {queue.assent_queue.map((item) => (
                <article className="panel clearance-request-card" key={item.session_student_id}>
                  <div className="clearance-card-header"><div><h3>{item.student_name}</h3><p className="clearance-reg">{item.registration_number}</p></div><span className="clearance-status status-requested">Ready for assent</span></div>
                  <div className="clearance-meta"><span><strong>Session</strong>{item.academic_session || item.session_name}</span><span><strong>Department / programme</strong>{[item.department, item.programme].filter(Boolean).join(' · ') || '—'}</span></div>
                  <label htmlFor={`assent-remarks-${item.session_student_id}`}>Remarks (optional)</label>
                  <textarea className="assent-remarks" id={`assent-remarks-${item.session_student_id}`} rows={2} maxLength={3000} value={assentDrafts[item.session_student_id] ?? ''} onChange={(e) => setAssentDrafts((old) => ({ ...old, [item.session_student_id]: e.target.value }))} />
                  <div className="assent-actions no-print">
                    <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void perform(`assent-${item.session_student_id}`, 'final_assent', { session_student_id: item.session_student_id, status: 'assented', remarks: assentDrafts[item.session_student_id] ?? '' }, `Final Assent granted to ${item.student_name}.`)}>Grant Final Assent</button>
                    <button className="danger-button" type="button" disabled={Boolean(busy)} onClick={() => void perform(`decline-${item.session_student_id}`, 'final_assent', { session_student_id: item.session_student_id, status: 'declined', remarks: assentDrafts[item.session_student_id] ?? '' }, `Final Assent declined for ${item.student_name}.`)}>Decline</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {isRegistrar && (
        <>
          <div className="clearance-section-heading">
            <div><p className="eyebrow dark">REGISTRAR</p><h3>Completed clearances</h3><p className="muted">Only students with Provost assent and a completion timestamp are listed.</p></div>
            <span className="role-count">{queue?.completed_queue.length ?? 0}</span>
          </div>
          <div className="panel registrar-completed">
            <div className="registrar-actions no-print">
              <p className="muted">Use Print to print this completed-clearance register. Individual clearance-form printing requires the final form template.</p>
              <button className="secondary-button" type="button" onClick={() => window.print()} disabled={!queue?.completed_queue.length}>Print register</button>
            </div>
            {!queue?.completed_queue.length ? <p className="muted">No completed clearances yet.</p> : (
              <div className="staff-table-wrap">
                <table className="staff-table"><thead><tr><th>Student</th><th>Registration no.</th><th>Department / programme</th><th>Session</th><th>Completed</th></tr></thead>
                  <tbody>{queue.completed_queue.map((item) => <tr key={item.session_student_id}><td>{item.student_name}</td><td>{item.registration_number}</td><td>{[item.department, item.programme].filter(Boolean).join(' · ') || '—'}</td><td>{item.academic_session || item.session_name}</td><td>{dateText(item.completed_at)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

