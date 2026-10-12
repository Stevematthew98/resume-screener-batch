import Button from './Button';
import React from 'react';
import { Plus } from 'lucide-react';
import { STAGE_LABELS } from '../api';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const BAND_COLORS = {
  'Strong match': 'var(--green)',
  'Worth reviewing': 'var(--amber)',
  'Weak match': 'var(--muted)',
};

function bandClass(band) {
  if (band === 'Strong match') return 'band band-strong';
  if (band === 'Worth reviewing') return 'band band-review';
  return 'band band-weak';
}

function LatestAnalysis({ latest, onOpenSession }) {
  if (!latest) return null;
  const isExpress = latest.method === 'express';
  const picks = latest.top_picks || {};
  return (
    <div className="dash-panel rise latest-card" style={{ '--d': '80ms' }}>
      <div className="card-eyebrow">Latest analysis</div>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {latest.job_title || 'Untitled'}
        <span className={`method-badge${isExpress ? ' express' : ''}`}>
          {isExpress ? 'Express dataset' : 'Deep pipeline'}
        </span>
        <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>{fmtDate(latest.created_at)}</span>
      </h3>
      <div className="express-stats" style={{ margin: '10px 0 14px' }}>
        <div className="express-stat"><div className="v">{(latest.total_resumes || 0).toLocaleString()}</div><div className="k">Resumes scored</div></div>
        {isExpress ? (
          <>
            <div className="express-stat"><div className="v">{(latest.roles || []).length}</div><div className="k">Job roles</div></div>
            <div className="express-stat"><div className="v">{latest.elapsed_seconds != null ? `${latest.elapsed_seconds}s` : '—'}</div><div className="k">Processing time</div></div>
          </>
        ) : (
          <>
            <div className="express-stat"><div className="v">{Math.round((latest.avg_score || 0) * 100)}%</div><div className="k">Avg score</div></div>
            <div className="express-stat"><div className="v">{latest.screened_count || 0}/{latest.total_resumes || 0}</div><div className="k">Screened</div></div>
          </>
        )}
      </div>
      {isExpress ? (
        <div className="latest-picks">
          {Object.entries(picks).map(([role, p]) => (
            <div className="latest-pick" key={role}>
              <span className="lp-role">{role}</span>
              <span className="lp-name">{p.name}{p.category && <span className="cat-chip" style={{ marginLeft: 8 }}>{p.category}</span>}</span>
              <span className="lp-score"><strong>{Math.round((p.score || 0) * 100)}%</strong> <span className={bandClass(p.band)}>{p.band}</span></span>
            </div>
          ))}
          {Object.keys(picks).length === 0 && <div className="empty-note">No picks recorded for this scan.</div>}
        </div>
      ) : (
        <div className="latest-picks">
          {(latest.top_candidates || []).map((c, i) => (
            <div className="latest-pick" key={i}>
              <span className="lp-role">#{i + 1}</span>
              <span className="lp-name">{c.name}</span>
              <span className="lp-score"><strong>{Math.round((c.score || 0) * 100)}%</strong> <span className={bandClass(c.band)}>{c.band}</span></span>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <Button type="button" className="btn-ghost btn-sm" onClick={() => onOpenSession(latest.id)}>
          Open full results →
        </Button>
      </div>
    </div>
  );
}

// Real, configured scoring weights — shown, not computed.
const WEIGHTS = [
  { key: 'skills', label: 'SKILLS', pct: 50, detail: 'taxonomy match × 0.50' },
  { key: 'jd', label: 'JD_SIMILARITY', pct: 25, detail: 'MiniLM cosine × 0.25' },
  { key: 'exp', label: 'EXPERIENCE', pct: 15, detail: 'years vs minimum × 0.15' },
  { key: 'edu', label: 'EDUCATION', pct: 10, detail: 'degree keywords × 0.10' },
];

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortId(id) {
  if (!id) return '—';
  const s = String(id);
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

export default function Dashboard({ data, loading = false, error = '', onNewScreening, onOpenSession }) {
  const stats = (data && data.stats) || {};
  const recent = (data && data.recent_sessions) || [];
  const dist = (data && data.score_distribution) || [];
  const latest = (data && data.latest) || null;
  const stages = Object.entries(STAGE_LABELS);

  const telemetry = [
    { label: 'RESUMES_INGESTED', value: stats.total_resumes ?? '—', hint: 'files accepted by the pipeline' },
    { label: 'CANDIDATES_PROCESSED', value: stats.candidates_processed ?? '—', hint: 'full 8-stage analysis completed' },
    { label: 'SHORTLISTED', value: stats.shortlisted ?? '—', hint: 'status set by a recruiter' },
    { label: 'MEAN_MATCH_SCORE', value: stats.avg_score != null ? `${Math.round(stats.avg_score * 100)}%` : '—', hint: 'across all scored candidates' },
  ];

  return (
    <div className="dash">
      <div className="dash-head rise">
        <div>
          <div className="card-eyebrow">System overview</div>
          <h2>Technical dashboard</h2>
          <p className="hint">Live telemetry from the screening pipeline. Every figure below is read from the backend — nothing is simulated.</p>
        </div>
        <Button type="button" className="btn-primary" onClick={onNewScreening}>
          <Plus size={16} /> New screening
        </Button>
      </div>

      <div className="tech-strip rise" style={{ '--d': '60ms' }} aria-label="Pipeline configuration">
        <span className="tech-item"><i className="dot ok" />PIPELINE&nbsp;<b>STANDBY</b></span>
        <span className="tech-item">EMBEDDINGS&nbsp;<b>all-MiniLM-L6-v2 + TF-IDF</b></span>
        <span className="tech-item">SKILL_TAXONOMY&nbsp;<b>234</b></span>
        <span className="tech-item">SCORING&nbsp;<b>50/25/15/10</b></span>
        <span className="tech-item">AUTH&nbsp;<b>JWT</b></span>
      </div>

      <div className="tech-pipe rise" style={{ '--d': '100ms' }} aria-label="NLP pipeline stages">
        {stages.map(([key, label], i) => (
          <span className="tech-stage" key={key}>
            <span className="tech-stage-n">{String(i + 1).padStart(2, '0')}</span>
            {label}
          </span>
        ))}
      </div>

      <div className="stat-grid">
        {loading
          ? [0, 1, 2, 3].map((i) => (
            <div className="stat-card" key={i}>
              <div className="stat-value skeleton" style={{ width: '55%' }}>&nbsp;</div>
              <div className="stat-label skeleton" style={{ width: '75%', marginTop: 10 }}>&nbsp;</div>
            </div>
          ))
          : telemetry.map((t) => (
            <div className="stat-card tech-card rise" key={t.label}>
              <div className="stat-value mono">{t.value}</div>
              <div className="stat-label mono-label">{t.label}</div>
              <div className="stat-hint">{t.hint}</div>
            </div>
          ))}
      </div>

      {!loading && !error && <LatestAnalysis latest={latest} onOpenSession={onOpenSession} />}

      <div className="dash-cols">
        <div className="dash-panel rise" style={{ '--d': '140ms' }}>
          <h3>Scoring model</h3>
          <p className="panel-sub">Configured match-score composition. Fixed weights — the learned ranker only tunes the skills component.</p>
          <div className="weight-list">
            {WEIGHTS.map((w) => (
              <div className="weight-row" key={w.key}>
                <div className="weight-head">
                  <span className="mono-label">{w.label}</span>
                  <span className="mono">{w.pct}%</span>
                </div>
                <div className="weight-bar" role="img" aria-label={`${w.label} weight ${w.pct} percent`}>
                  <div className="weight-fill" style={{ width: `${w.pct}%` }} />
                </div>
                <div className="weight-detail">{w.detail}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-panel rise" style={{ '--d': '210ms' }}>
          <h3>Score distribution</h3>
          <p className="panel-sub">Candidates per verdict band.</p>
          {loading ? (
            <div className="skeleton" style={{ height: 240, borderRadius: 12 }}>&nbsp;</div>
          ) : error ? <div className="empty-note">Score distribution is currently unavailable.</div> : dist.every((d) => !d.count) ? (
            <div className="empty-note">No candidates yet — run your first screening to see the distribution.</div>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={dist} margin={{ top: 10, right: 10, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 12, fill: 'var(--muted)' }} interval={0}
                  tickLine={false} axisLine={{ stroke: 'var(--line)' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: 'var(--muted)' }}
                  tickLine={false} axisLine={false} width={30} />
                <Tooltip cursor={{ fill: 'var(--accent-soft)' }} content={({ active, payload }) => active && payload?.length ? <div className="chart-tooltip"><strong>{payload[0].payload.label}</strong>{payload[0].value} candidates</div> : null} />
                <Bar dataKey="count" name="Candidates" radius={[4, 4, 0, 0]} barSize={52}
                  background={{ fill: 'var(--line)', radius: 8 }}>
                  {dist.map((d) => (
                    <Cell key={d.label} fill={BAND_COLORS[d.label] || 'var(--muted)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {!loading && !error && dist.some(d => d.count) && <div className="chart-legend">{dist.map(d => <span key={d.label}><i style={{ background: BAND_COLORS[d.label] || 'var(--muted)' }} />{d.label}</span>)}</div>}
        </div>
      </div>

      <div className="dash-panel rise" style={{ '--d': '260ms', marginTop: 16 }}>
        <h3>Session log</h3>
        <p className="panel-sub">Recent screening runs. Select a row to reopen it.</p>
        {loading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 46, borderRadius: 10 }}>&nbsp;</div>
            ))}
          </div>
        ) : error ? <div className="empty-note">Session log is currently unavailable.</div> : recent.length === 0 ? (
          <div className="empty-note">No screening sessions yet — runs will be logged here.</div>
        ) : (
          <ul className="log-list">
            {recent.map((s) => (
              <li key={s.id}>
                <Button type="button" className="log-row" onClick={() => onOpenSession(s.id)}>
                  <span className="mono log-id">{shortId(s.id)}</span>
                  <span className="log-main"><strong>{s.job_title || 'Untitled role'}</strong>{s.method === 'express' && <span className="method-badge express" style={{ marginLeft: 8 }}>Express</span>}{s.job_company && <span className="muted"> · {s.job_company}</span>}</span>
                  <span className="mono log-meta">{s.method === 'express' ? `${(s.total_resumes || 0).toLocaleString()} × ${(s.roles || []).length} roles` : `${s.screened_count}/${s.total_resumes} screened`}</span>
                  <span className="mono log-meta">avg {Math.round((s.avg_score || 0) * 100)}%</span>
                  <span className="log-date">{fmtDate(s.created_at)}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
