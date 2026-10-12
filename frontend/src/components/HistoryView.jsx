import Button from './Button';
import { BriefcaseBusiness, History, Plus, Trash2, ArrowRight } from 'lucide-react';
import React from 'react';

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HistoryView({ sessions, loading = false, error: loadError = '', onOpenSession }) {
  return (
    <div className="history">
      <div className="dash-head">
        <div>
          <h2>Screening history</h2>
          <p>Every batch you've screened, with its ranking snapshot saved.</p>
        </div>
      </div>

      {loading ? <div className="stat-grid" role="status" aria-label="Loading sessions">{[0,1,2].map(i => <div key={i} className="skeleton" style={{height: 140}} />)}</div> : loadError ? <div className="empty-note">Sessions are currently unavailable.</div> : sessions.length === 0 ? (
        <div className="empty-card"><div className="empty-ico"><History size={22} /></div>
          <h3>No sessions yet</h3>
          <p>Run your first screening and it will appear here with the full ranking.</p>
        </div>
      ) : (
        <ul className="session-list big">
          {sessions.map((s) => {
            const isExpress = s.method === 'express';
            return (
            <li key={s.id}>
              <Button type="button" className="session-row" onClick={() => onOpenSession(s.id)}>
                <span className="session-main">
                  <strong>#{s.id} · {s.job_title || 'Untitled role'}</strong>
                  {isExpress && <span className="method-badge express" style={{ marginLeft: 8 }}>Express dataset</span>}
                  {s.job_company && <span className="muted"> · {s.job_company}</span>}
                </span>
                <span className="session-meta">
                  {isExpress
                    ? `${(s.total_resumes || 0).toLocaleString()} resumes × ${(s.roles || []).length} roles`
                    : `${s.screened_count}/${s.total_resumes} screened`} · avg {Math.round((s.avg_score || 0) * 100)}%
                </span>
                <span className="session-date">{fmtDate(s.created_at)}</span>
                <span className="link-arrow">View →</span>
              </Button>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
