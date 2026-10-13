import Button from './Button';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import SkillGaps from './SkillGaps';
import { getRankerStatus, sendFeedback } from '../api';

export const STATUS_META = {
  'New': { cls: 'st-new', label: 'New' },
  'Screened': { cls: 'st-screened', label: 'Screened' },
  'Shortlisted': { cls: 'st-shortlisted', label: 'Shortlisted' },
  'Under Review': { cls: 'st-review', label: 'Under Review' },
  'Rejected': { cls: 'st-rejected', label: 'Rejected' },
};

export function StatusChip({ status }) {
  const meta = STATUS_META[status] || STATUS_META['New'];
  return <span className={`status-chip ${meta.cls}`}>{meta.label}</span>;
}

function BandChip({ band }) {
  const cls = band === 'Strong match' ? 'band-strong' : band === 'Worth reviewing' ? 'band-review' : 'band-weak';
  return <span className={`band-chip ${cls}`}>{band}</span>;
}

function ScoreBar({ value, color }) {
  return (
    <div className="scorebar">
      <div className="scorebar-fill" style={{ width: `${Math.round(value * 100)}%`, background: color }} />
    </div>
  );
}

function Collapsible({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <Button type="button" className="collapsible-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        <span className={`chev ${open ? 'open' : ''}`}>▾</span>
      </Button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

function ScoreRing({ score, size = 120 }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const color = score >= 0.65 ? 'var(--green)' : score >= 0.4 ? 'var(--amber)' : 'var(--muted)';
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 120 120">
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={color} />
            <stop offset="100%" stopColor={color} stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--line)" strokeWidth="11" />
        <circle cx="60" cy="60" r={r} fill="none" stroke="url(#ringGrad)" strokeWidth="11"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score)}
          transform="rotate(-90 60 60)" className="ring-anim" />
      </svg>
      <div className="ring-label">
        <span className="ring-num">{Math.round(score * 100)}</span>
        <span className="ring-den">/ 100</span>
      </div>
    </div>
  );
}

const COMPONENT_ORDER = ['skills', 'jd_similarity', 'experience', 'education'];
const COMPONENT_MAX_POINTS = { skills: 50, jd_similarity: 25, experience: 15, education: 10 };

function CandidateDetail({ candidate, statusInfo, onClose, onStatus, readOnly = false }) {
  const [notes, setNotes] = useState(statusInfo.notes || '');
  const [rejectReason, setRejectReason] = useState(statusInfo.reject_reason || '');
  const [showReject, setShowReject] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [voteMsg, setVoteMsg] = useState('');
  const [voted, setVoted] = useState(null);
  const dialogRef = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.querySelector('button')?.focus();
    function handleKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll('button:not(:disabled), input, textarea, a[href], [tabindex="0"]') || [])];
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', handleKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey); previous?.focus?.(); };
  }, [onClose]);
  const p = candidate.personal || {};
  const displayName = p.name || candidate.filename.replace(/\.[^.]+$/, '');
  const personalization = candidate.personalization || {};

  async function vote(helpful) {
    setVoteMsg('');
    try {
      // resume_id doubles as the analysis key for batch candidates; the
      // backend links the vote to this candidate for the learned ranker.
      await sendFeedback(candidate.resume_id, helpful, candidate.resume_id);
      setVoted(helpful);
      setVoteMsg('Thanks — your vote helps tune future scores.');
    } catch (e) {
      setVoteMsg(e.message || 'Could not save your vote.');
    }
  }

  async function changeStatus(status) {
    if (status === 'Rejected' && !rejectReason.trim()) {
      setMsg('Please add a short reason — every rejection should be explainable.');
      return;
    }
    setSaving(true);
    setMsg('');
    try {
      await onStatus(candidate.resume_id, status, notes, status === 'Rejected' ? rejectReason : '');
      setMsg('Saved.');
      setShowReject(false);
    } catch (e) {
      setMsg(e.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function saveNotes() {
    setSaving(true);
    setMsg('');
    try {
      await onStatus(candidate.resume_id, statusInfo.status, notes,
        statusInfo.status === 'Rejected' ? rejectReason : statusInfo.reject_reason);
      setMsg('Notes saved.');
    } catch (e) {
      setMsg(e.message || 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const sections = candidate.sections || {};
  const sectionCards = [
    ['Experience', sections.experience],
    ['Projects', sections.projects],
    ['Education', sections.education],
    ['Certifications', sections.certifications],
    ['Summary', sections.summary],
  ].filter(([, text]) => text && text.trim());

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="candidate-name" onClick={(e) => e.stopPropagation()}>
        <Button className="modal-close" onClick={onClose} aria-label="Close">✕</Button>

        <div className="detail-head">
          <div className="detail-id">
            <div className="avatar">{displayName.charAt(0).toUpperCase()}</div>
            <div>
              <h2 id="candidate-name">{displayName}</h2>
              <div className="detail-contact">
                {p.email && <span>✉️ {p.email}</span>}
                {p.phone && <span>📞 {p.phone}</span>}
              </div>
              <div className="detail-chips">
                <BandChip band={candidate.band} />
                <StatusChip status={statusInfo.status} />
              </div>
            </div>
          </div>
          <ScoreRing score={candidate.score} />
        </div>

        <div className="detail-grid">
          <div>
            <h3>Why this score</h3>
            <ul className="explain-list">
              {(candidate.explanation || []).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>

            {personalization.active && (
              <div className="personal-note">
                <strong>Tuned to your decisions.</strong> {personalization.note}
                {(personalization.adjustments || []).length > 0 && (
                  <ul>
                    {personalization.adjustments.map((a) => (
                      <li key={a.skill}>{a.note}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <h3>Score breakdown</h3>
            <div className="components">
              {COMPONENT_ORDER.map((key) => {
                const comp = candidate.components[key];
                if (!comp) return null;
                const max = COMPONENT_MAX_POINTS[key];
                return (
                  <div key={key} className="component">
                    <div className="component-head">
                      <span className="component-name">{comp.label}</span>
                      <span className="component-points">{comp.points} <span className="muted">of {max} pts</span></span>
                    </div>
                    <ScoreBar value={max ? comp.points / max : 0}
                      color={comp.points / max >= 0.7 ? 'var(--green)' : comp.points / max >= 0.4 ? 'var(--amber)' : 'var(--muted)'} />
                    <p className="component-detail">{comp.detail}</p>
                  </div>
                );
              })}
            </div>
            <p className="fairness">{candidate.fairness_note}</p>

            <h3>Skills</h3>
            <div className="chip-group-label">Matched</div>
            <div className="chips">
              {candidate.matched_skills.length ? candidate.matched_skills.map((s) => (
                <span key={s} className="chip chip-green">✓ {s}</span>
              )) : <span className="muted">None of the required skills were found.</span>}
            </div>
            <div className="chip-group-label">Not detected</div>
            <div className="chips">
              {candidate.missing_skills.length ? candidate.missing_skills.map((s) => (
                <span key={s} className="chip chip-amber">{s}</span>
              )) : <span className="muted">Nothing missing.</span>}
            </div>
            {candidate.components?.skills?.detection_note && (
              <p className="hint" style={{ marginTop: 8 }}>{candidate.components.skills.detection_note}</p>
            )}
            {candidate.components?.skills?.preferred_matched?.length > 0 && (
              <>
                <div className="chip-group-label">Preferred skills found (bonus, not scored)</div>
                <div className="chips">
                  {candidate.components.skills.preferred_matched.map((s) => (
                    <span key={s} className="chip chip-blue">★ {s}</span>
                  ))}
                </div>
              </>
            )}
          </div>

          <div>
            <h3>At a glance</h3>
            <div className="facts facts-col">
              <div className="fact"><span className="fact-num">{candidate.experience_years}</span><span className="fact-label">years of experience (approx.)</span></div>
              <div className="fact"><span className="fact-num">{candidate.matched_skills.length}/{candidate.matched_skills.length + candidate.missing_skills.length}</span><span className="fact-label">required skills matched</span></div>
            </div>
            {(candidate.degrees?.length > 0 || candidate.job_titles?.length > 0) && (
              <div className="facts-text">
                {candidate.degrees?.length > 0 && <p><strong>Education:</strong> {candidate.degrees.join(', ')}</p>}
                {candidate.job_titles?.length > 0 && <p><strong>Recent roles:</strong> {candidate.job_titles.slice(0, 3).join(' · ')}</p>}
              </div>
            )}

            <h3>Resume sections</h3>
            {sectionCards.map(([title, text]) => (
              <Collapsible key={title} title={title}>
                <p className="section-text">{text}</p>
              </Collapsible>
            ))}

            <h3>Decision</h3>
            {!readOnly ? (
            <div className="decision-box">
              <p className="hint">Rankings assist you — they never decide. No candidate is ever rejected automatically.</p>
              <div className="decision-actions">
                <Button className="btn-primary" disabled={saving} onClick={() => changeStatus('Shortlisted')}>Shortlist</Button>
                <Button className="btn-ghost" disabled={saving} onClick={() => changeStatus('Under Review')}>Mark for review</Button>
                <Button className="btn-danger-ghost" disabled={saving} onClick={() => setShowReject(!showReject)}>Reject</Button>
              </div>
              {showReject && (
                <div className="reject-box">
                  <input type="text" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                    aria-label="Reason for rejection" placeholder="Reason for rejection (required)" />
                  <Button className="btn-danger" disabled={saving} onClick={() => changeStatus('Rejected')}>Confirm rejection</Button>
                </div>
              )}
              <label className="field" style={{ marginTop: 12 }}>
                <span className="field-label">Recruiter notes</span>
                <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                  placeholder="Private notes about this candidate…" />
              </label>
              <Button className="btn-ghost" disabled={saving} onClick={saveNotes}>Save notes</Button>
              <div className="vote-row">
                <span className="muted">Was this analysis helpful?</span>
                <Button type="button" className={`vote-btn ${voted === true ? 'voted' : ''}`}
                  disabled={voted !== null} onClick={() => vote(true)} aria-label="Helpful">👍</Button>
                <Button type="button" className={`vote-btn ${voted === false ? 'voted' : ''}`}
                  disabled={voted !== null} onClick={() => vote(false)} aria-label="Not helpful">👎</Button>
                {voteMsg && <span className="muted">{voteMsg}</span>}
              </div>
              {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
              {statusInfo.reject_reason && statusInfo.status === 'Rejected' && (
                <p className="reject-note"><strong>Rejection reason:</strong> {statusInfo.reject_reason}</p>
              )}
            </div>
            ) : (
            <div className="decision-box">
              <p className="hint">Saved snapshot — status and notes as recorded at screening time.</p>
              {statusInfo.notes && <p><strong>Notes:</strong> {statusInfo.notes}</p>}
              {statusInfo.reject_reason && <p><strong>Rejection reason:</strong> {statusInfo.reject_reason}</p>}
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Ranking table: sortable by score, filterable by skill/experience, searchable by name.
 */
export default function RankingView({ job, ranking, candidates, statuses, onSelectCandidate, onStatusChange, onRestart, sessionId = null, readOnly = false, onExport = null, onBack = null, summary = null, onReplay = null }) {
  const [query, setQuery] = useState('');
  const [skillFilter, setSkillFilter] = useState('');
  const [minExpFilter, setMinExpFilter] = useState('');
  const [sortDir, setSortDir] = useState('desc');
  const [exporting, setExporting] = useState('');
  const [ranker, setRanker] = useState(null);

  useEffect(() => {
    let alive = true;
    getRankerStatus().then((r) => { if (alive) setRanker(r); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  async function handleExport(kind) {
    if (!onExport || exporting) return;
    setExporting(kind);
    try {
      await onExport(kind);
    } catch (e) {
      alert(e.message || 'Export failed. Please try again.');
    } finally {
      setExporting('');
    }
  }

  const rows = useMemo(() => {
    let list = ranking.map((r) => ({
      ...r,
      status: (statuses[r.resume_id] || {}).status || r.status || 'Screened',
    }));
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => (r.name || '').toLowerCase().includes(q) || r.filename.toLowerCase().includes(q));
    const sf = skillFilter.trim().toLowerCase();
    if (sf) list = list.filter((r) => [...(r.matched_skills || []), ...(r.missing_skills || [])].some((s) => s.includes(sf)));
    const me = parseFloat(minExpFilter);
    if (!Number.isNaN(me)) list = list.filter((r) => (r.experience_years || 0) >= me);
    list = [...list].sort((a, b) => (sortDir === 'desc' ? b.score - a.score : a.score - b.score));
    return list;
  }, [ranking, statuses, query, skillFilter, minExpFilter, sortDir]);

  const shortlisted = rows.filter((r) => r.status === 'Shortlisted').length;

  return (
    <div>
      <section className="card rise">
        <div className="card-eyebrow">Screening complete</div>
        <h2>{job.title || 'Untitled role'}{job.company ? ` · ${job.company}` : ''}</h2>
        <p className="hint">
          {ranking.length} resume{ranking.length !== 1 ? 's' : ''} screened
          {shortlisted > 0 && <> · <strong>{shortlisted} shortlisted</strong></>}
          . Click a row for the full candidate profile. Rankings assist — you decide.
        </p>
        {ranker && ranker.active && (
          <p className="ranker-pill" title={ranker.note}>
            ✨ Scores tuned from your last {ranker.decisions} decisions
          </p>
        )}
        {summary && (
          <div className="summary-strip" aria-label="Analysis summary">
            <span className="mono">{summary.resumes} resumes</span>
            <span className="mono">avg {summary.avg}%</span>
            <span className="mono">{summary.strong} strong</span>
            <span className="mono">{summary.warnings} warnings</span>
            {onReplay && (
              <Button type="button" className="btn-ghost btn-sm" onClick={onReplay} style={{ marginLeft: 'auto' }}>
                Replay pipeline (≈80 sec)
              </Button>
            )}
          </div>
        )}
        <div className="toolbar">
          <input className="toolbar-input" type="text" value={query}
            onChange={(e) => setQuery(e.target.value)} aria-label="Search candidates by name or file" placeholder="Search by name or file…" />
          <input className="toolbar-input" type="text" value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)} aria-label="Filter by skill" placeholder="Filter by skill…" />
          <input className="toolbar-input toolbar-num" type="number" min="0" step="0.5" value={minExpFilter}
            onChange={(e) => setMinExpFilter(e.target.value)} aria-label="Minimum years of experience" placeholder="Min. yrs exp" />
          <Button className="btn-ghost btn-sm" onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
            Score {sortDir === 'desc' ? '↓' : '↑'}
          </Button>
          {onExport && (
            <span className="export-group">
              <Button className="btn-ghost btn-sm" disabled={!!exporting} onClick={() => handleExport('csv')}>
                {exporting === 'csv' ? '…' : '⬇ CSV'}
              </Button>
              <Button className="btn-ghost btn-sm" disabled={!!exporting} onClick={() => handleExport('xlsx')}>
                {exporting === 'xlsx' ? '…' : '⬇ Excel'}
              </Button>
              <Button className="btn-ghost btn-sm" disabled={!!exporting} onClick={() => handleExport('pdf')}>
                {exporting === 'pdf' ? '…' : '⬇ PDF report'}
              </Button>
            </span>
          )}
        </div>
      </section>

      {rows.length === 0 ? (
        <section className="card"><p className="muted">No candidates match these filters.</p></section>
      ) : (
        <section className="card table-card rise" style={{ '--d': '60ms' }}>
          <div className="table-wrap">
            <table className="rank-table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Candidate</th>
                  <th scope="col">Match score</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Skills</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.resume_id} onClick={() => onSelectCandidate(r.resume_id)} className="rank-row">
                    <td className="rank-num">{sortDir === 'desc' ? i + 1 : rows.length - i}</td>
                    <td>
                      <Button className="candidate-open cand-name" onClick={(e) => { e.stopPropagation(); onSelectCandidate(r.resume_id); }}>{r.name || r.filename.replace(/\.[^.]+$/, '')}</Button>
                      <div className="cand-sub">{r.experience_years} yrs exp</div>
                    </td>
                    <td>
                      <div className="score-cell">
                        <span className="score-pct">{Math.round(r.score * 100)}%</span>
                        <ScoreBar value={r.score} color={r.score >= 0.65 ? 'var(--green)' : r.score >= 0.4 ? 'var(--amber)' : 'var(--muted)'} />
                      </div>
                    </td>
                    <td><BandChip band={r.band} /></td>
                    <td>
                      <div className="skill-mini">
                        <span className="mini-green">✓ {r.matched_skills.length}</span>
                        <span className="mini-amber">○ {r.missing_skills.length} not detected</span>
                      </div>
                    </td>
                    <td><StatusChip status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {onBack && (
        <Button className="cta cta-secondary" type="button" onClick={onBack}>← Back to history</Button>
      )}
      {!readOnly && (
        <Button className="cta cta-secondary" type="button" onClick={onRestart}>Screen another batch →</Button>
      )}

      {sessionId && <SkillGaps sessionId={sessionId} />}
    </div>
  );
}

export { CandidateDetail, ScoreRing };
