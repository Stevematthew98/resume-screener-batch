import React, { useEffect, useMemo, useState } from 'react';
import Button from './Button';

function bandClass(band) {
  if (band === 'Strong match') return 'band band-strong';
  if (band === 'Worth reviewing') return 'band band-review';
  return 'band band-weak';
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function RoleTable({ candidates, role, limit }) {
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
            <th>Band</th>
            <th>Matched skills</th>
            <th>Exp.</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ c, s }, i) => (
            <tr key={c.id + i}>
              <td>{i + 1}</td>
              <td><strong>{c.name || c.id}</strong></td>
              <td>{c.category ? <span className="cat-chip">{c.category}</span> : <span style={{ color: '#94a3b8' }}>—</span>}</td>
              <td><strong>{Math.round(s.score * 100)}%</strong></td>
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

  useEffect(() => {
    if (express.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [express.status]);

  useEffect(() => { setTab(0); setShowAll(false); }, [express.result]);

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
        <RoleTable candidates={r.candidates} role={role} limit={limit} />
        {!showAll && r.candidates.length > 100 && (
          <div style={{ marginTop: 12, textAlign: 'center' }}>
            <Button type="button" className="btn-ghost btn-sm" onClick={() => setShowAll(true)}>
              Show all {r.candidates.length.toLocaleString()} ↓
            </Button>
          </div>
        )}
        <p className="hint" style={{ marginTop: 12 }}>
          Fairness note: names, colleges and contact details are never scored. Every candidate
          starts as Screened — scores measure fit to the role's listed criteria, not hiring success.
        </p>
      </div>
    </div>
  );
}
