import React, { useEffect, useMemo, useState } from 'react';
import Button from './Button';

const COMPONENT_ORDER = ['skills', 'jd_similarity', 'experience', 'education'];
const COMPONENT_MAX_POINTS = { skills: 50, jd_similarity: 25, experience: 15, education: 10 };

function bandClass(band) {
  if (band === 'Strong match') return 'band band-strong';
  if (band === 'Worth reviewing') return 'band band-review';
  return 'band band-weak';
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function gapPct(sc) {
  if (sc.skill_gap_pct != null) return sc.skill_gap_pct;
  const total = (sc.matched?.length || 0) + (sc.missing?.length || 0);
  return total ? Math.round((sc.missing.length / total) * 1000) / 10 : 0;
}

function MiniBar({ value, color }) {
  return (
    <div className="weight-bar" role="img" aria-label={`${Math.round(value * 100)} percent`}>
      <div className="weight-fill" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: color }} />
    </div>
  );
}

/* Per-resume analysis, mirroring the individual (deep) candidate detail. */
function CandidateAnalysis({ candidate, roles, initialRole, onClose }) {
  const [role, setRole] = useState(initialRole);
  const sc = candidate.scores.find((x) => x.role === role) || candidate.scores[0];
  const comps = sc.components || {};
  const gap = gapPct(sc);
  const total = (sc.matched?.length || 0) + (sc.missing?.length || 0);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Analysis of ${candidate.name}`} onClick={(e) => e.stopPropagation()}>
        <Button className="modal-close" onClick={onClose} aria-label="Close">✕</Button>
        <div className="detail-head">
          <div className="detail-id">
            <div className="avatar">{(candidate.name || '?').charAt(0).toUpperCase()}</div>
            <div>
              <h3 id="candidate-name" style={{ margin: 0 }}>{candidate.name}</h3>
              <div className="detail-contact">
                {candidate.category && <span className="cat-chip">{candidate.category}</span>}
                {' '}<span className={bandClass(sc.band)}>{sc.band}</span>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="hint" htmlFor="ea-role">Role</label>
            <select id="ea-role" value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <h3>Score breakdown · {role}</h3>
        <div className="components">
          {COMPONENT_ORDER.map((key) => {
            const comp = comps[key];
            if (!comp) return null;
            const max = COMPONENT_MAX_POINTS[key];
            const frac = max ? comp.points / max : 0;
            return (
              <div key={key} className="component">
                <div className="component-head">
                  <span className="component-name">{comp.label}</span>
                  <span className="component-points">{comp.points} <span className="muted">of {max} pts</span></span>
                </div>
                <MiniBar value={frac} color={frac >= 0.7 ? 'var(--green)' : frac >= 0.4 ? 'var(--amber)' : 'var(--muted)'} />
                <p className="component-detail">{comp.detail}</p>
              </div>
            );
          })}
          {Object.keys(comps).length === 0 && (
            <p className="hint">Detailed breakdown was not stored for this scan — upgrade scans record it per resume.</p>
          )}
        </div>

        <h3>Skill gap · {Math.round(gap)}%</h3>
        <p className="hint" style={{ marginTop: -6 }}>
          {sc.missing?.length || 0} of {total} required skills were not detected in this resume.
          “Not detected” means absent from the available text — not proven absent from the person.
        </p>
        <div className="chip-group-label">Matched</div>
        <div className="chips">
          {sc.matched?.length ? sc.matched.map((s) => (
            <span key={s} className="chip chip-green">✓ {s}</span>
          )) : <span className="muted">None of the required skills were found.</span>}
        </div>
        <div className="chip-group-label">Not detected</div>
        <div className="chips">
          {sc.missing?.length ? sc.missing.map((s) => (
            <span key={s} className="chip chip-amber">{s}</span>
          )) : <span className="muted">Nothing missing.</span>}
        </div>

        <h3>At a glance</h3>
        <div className="facts facts-col">
          <div className="fact"><span className="fact-num">{Math.round(sc.score * 100)}%</span><span className="fact-label">match score for {role}</span></div>
          <div className="fact"><span className="fact-num">{sc.exp_years != null ? sc.exp_years : '—'}</span><span className="fact-label">years of experience (approx.)</span></div>
          <div className="fact"><span className="fact-num">{sc.matched?.length || 0}/{total}</span><span className="fact-label">required skills matched</span></div>
        </div>
        <p className="fairness">
          Names, colleges and contact details are never scored. Every candidate starts as Screened —
          this score measures fit to the role's listed criteria, not hiring success. Human review is mandatory.
        </p>
      </div>
    </div>
  );
}

/* Aggregate skill gaps for the selected role — "what this dataset is missing". */
function DatasetSkillGaps({ candidates, role }) {
  const rows = useMemo(() => {
    const counts = {};
    candidates.forEach((c) => {
      const sc = c.scores.find((x) => x.role === role);
      (sc?.missing || []).forEach((m) => { counts[m] = (counts[m] || 0) + 1; });
    });
    const n = candidates.length || 1;
    return Object.entries(counts)
      .map(([skill, count]) => ({ skill, pct: count / n }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 12);
  }, [candidates, role]);
  if (!rows.length) return null;
  return (
    <div className="dash-panel" style={{ marginTop: 16 }}>
      <h3>What this dataset is missing · {role}</h3>
      <p className="panel-sub">Required skills most often not detected across all {candidates.length.toLocaleString()} resumes.</p>
      <div className="weight-list">
        {rows.map((r) => (
          <div className="weight-row" key={r.skill}>
            <div className="weight-head">
              <span className="mono-label">{r.skill}</span>
              <span className="mono">{Math.round(r.pct * 100)}% missing</span>
            </div>
            <MiniBar value={r.pct} color={r.pct >= 0.7 ? 'var(--red, #dc2626)' : r.pct >= 0.4 ? 'var(--amber)' : 'var(--green)'} />
          </div>
        ))}
      </div>
    </div>
  );
}

function RoleTable({ candidates, role, limit, onSelect }) {
  const ranked = useMemo(() => {
    const rows = candidates
      .map((c) => ({ c, s: c.scores.find((x) => x.role === role) }))
      .filter((r) => r.s)
      .sort((a, b) => b.s.score - a.s.score);
    return rows.slice(0, limit);
  }, [candidates, role, limit]);
  return (
    <div className="express-table-wrap">
      <table className="express-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Candidate</th>
            <th>Dataset category</th>
            <th>Score</th>
            <th>Skill gap</th>
            <th>Band</th>
            <th>Matched skills</th>
            <th>Exp.</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ c, s }, i) => (
            <tr key={c.id + i} onClick={() => onSelect(c)} style={{ cursor: 'pointer' }} title="Open per-resume analysis">
              <td>{i + 1}</td>
              <td><strong>{c.name || c.id}</strong></td>
              <td>{c.category ? <span className="cat-chip">{c.category}</span> : <span style={{ color: '#94a3b8' }}>—</span>}</td>
              <td><strong>{Math.round(s.score * 100)}%</strong></td>
              <td>{Math.round(gapPct(s))}%</td>
              <td><span className={bandClass(s.band)}>{s.band}</span></td>
              <td>
                {s.matched.slice(0, 6).map((m) => (
                  <span key={m} className="skill-chip">{m}</span>
                ))}
                {s.matched.length > 6 && <span className="skill-chip">+{s.matched.length - 6}</span>}
                {s.matched.length === 0 && <span style={{ color: '#94a3b8' }}>—</span>}
              </td>
              <td>{s.exp_years ? `${s.exp_years}y` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ExpressResults({ express, onBack }) {
  const [tab, setTab] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (express.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [express.status]);

  useEffect(() => { setTab(0); setShowAll(false); setSelected(null); }, [express.result]);

  if (express.status === 'running') {
    return (
      <div className="card rise">
        <div className="express-progress">
          <div className="card-eyebrow">Express dataset scan</div>
          <h2>Scoring {express.total?.toLocaleString()} resumes against {express.roles?.length} roles…</h2>
          <div className="express-bar"><div /></div>
          <p className="hint">Elapsed {fmtElapsed(now - express.startedAt)} · target: under 45 seconds</p>
          <p className="express-method" style={{ maxWidth: 560, margin: '16px auto 0' }}>
            Rapid scan in progress — TF-IDF keyword similarity + skill matching.
            Not the deep 8-stage pipeline.
          </p>
        </div>
      </div>
    );
  }

  if (express.status === 'error') {
    return (
      <div className="card rise">
        <div className="card-eyebrow">Express dataset scan</div>
        <h2>Scan failed</h2>
        <div className="alert" role="alert">{express.error}</div>
        <Button type="button" className="btn-ghost" onClick={onBack}>← Back to setup</Button>
      </div>
    );
  }

  const r = express.result;
  if (!r) return null;
  const role = r.roles[tab];
  const limit = showAll ? r.candidates.length : 100;
  const strong = r.candidates.filter((c) => c.scores.some((s) => s.band === 'Strong match')).length;

  return (
    <div className="express-wrap">
      <div className="card rise">
        <div className="card-eyebrow">Express dataset scan · complete</div>
        <h2>{r.dataset.scored_rows.toLocaleString()} resumes scored against {r.roles.length} roles</h2>
        <div className="express-stats" style={{ margin: '12px 0' }}>
          <div className="express-stat"><div className="v">{r.elapsed_seconds}s</div><div className="k">Processing time</div></div>
          <div className="express-stat"><div className="v">{r.candidates.length.toLocaleString()}</div><div className="k">Resumes scored</div></div>
          <div className="express-stat"><div className="v">{r.roles.length}</div><div className="k">Job roles</div></div>
          <div className="express-stat"><div className="v">{strong.toLocaleString()}</div><div className="k">Strong matches</div></div>
        </div>
        {r.dataset.truncated && (
          <p className="hint">Dataset had {r.dataset.total_rows.toLocaleString()} rows — scored the first {r.dataset.scored_rows.toLocaleString()}.</p>
        )}
        <p className="express-method">{r.method_note}</p>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Button type="button" className="btn-ghost btn-sm" onClick={onBack}>← New scan</Button>
        </div>
      </div>

      <div className="card rise" style={{ '--d': '80ms' }}>
        <div className="card-eyebrow">Per-role ranking</div>
        <div className="express-tabs" style={{ margin: '8px 0 12px' }}>
          {r.roles.map((t, i) => (
            <button key={t} type="button" className={`express-tab${i === tab ? ' active' : ''}`} onClick={() => { setTab(i); setShowAll(false); }}>
              {t}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 0 }}>Click any row for the full per-resume analysis — score breakdown, skill gap %, matched and missing skills.</p>
        <RoleTable candidates={r.candidates} role={role} limit={limit} onSelect={setSelected} />
        {!showAll && r.candidates.length > 100 && (
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Button type="button" className="btn-ghost btn-sm" onClick={() => setShowAll(true)}>
              Show all {r.candidates.length.toLocaleString()} ↓
            </Button>
          </div>
        )}
        <DatasetSkillGaps candidates={r.candidates} role={role} />
        <p className="hint" style={{ marginTop: 12 }}>
          Fairness note: names, colleges and contact details are never scored. Every candidate
          starts as Screened — scores measure fit to the role's listed criteria, not hiring success.
        </p>
      </div>

      {selected && (
        <CandidateAnalysis
          candidate={selected}
          roles={r.roles}
          initialRole={role}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
