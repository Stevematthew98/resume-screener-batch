import React, { useRef, useState } from 'react';
import JSZip from 'jszip';
import Button from './Button';
import { Zap } from 'lucide-react';

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {hint && <span className="field-hint">{hint}</span>}
      {children}
    </label>
  );
}

export const DEFAULT_ROLES = [
  { title: 'Data Scientist', requiredSkills: 'python, machine learning, statistics, pandas, scikit-learn, sql, data visualization', minExp: 3 },
  { title: 'Software Engineer', requiredSkills: 'python, java, javascript, sql, git, apis', minExp: 2 },
  { title: 'Designer', requiredSkills: 'ui design, ux design, photoshop, illustrator, figma', minExp: 2 },
  { title: 'HR Manager', requiredSkills: 'recruitment, onboarding, employee relations, hr policies', minExp: 3 },
  { title: 'Accountant', requiredSkills: 'accounting, tally, taxation, excel, financial reporting', minExp: 2 },
];

function RoleCard({ role, index, onChange, onRemove, canRemove }) {
  const set = (k, v) => onChange(index, { ...role, [k]: v });
  return (
    <div className="role-card">
      <div className="role-head">
        <span className="role-num">Role {index + 1}</span>
        {canRemove && (
          <Button type="button" className="btn-ghost btn-sm" onClick={() => onRemove(index)} aria-label={`Remove ${role.title || 'role'}`}>✕</Button>
        )}
      </div>
      <div className="form-row">
        <Field label="Job title">
          <input type="text" value={role.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Data Scientist" />
        </Field>
        <Field label="Min. experience (yrs)">
          <input type="number" min="0" step="0.5" value={role.minExp} onChange={(e) => set('minExp', e.target.value)} placeholder="e.g. 2" />
        </Field>
      </div>
      <Field label="Required skills" hint="Comma-separated. Every resume is scored against every role.">
        <input type="text" value={role.requiredSkills} onChange={(e) => set('requiredSkills', e.target.value)} placeholder="e.g. python, sql, machine learning" />
      </Field>
    </div>
  );
}

// Sample posting used by the "demo filler". Clearly illustrative — the
// recruiter uploads their own resumes and can edit every field afterwards.
const DEMO_JOB = {
  title: 'Data Scientist',
  company: 'Acme Analytics',
  jdText: `We are hiring a Data Scientist to join our analytics team in Bengaluru.

Responsibilities:
- Build and deploy machine learning models for customer analytics
- Design experiments and analyse A/B test results
- Build dashboards and communicate insights to stakeholders
- Write production-quality Python and SQL

Must have:
- 2+ years of experience in data science or analytics
- Strong Python (pandas, scikit-learn) and SQL
- Solid grasp of statistics and machine learning fundamentals

Nice to have:
- Deep learning (TensorFlow/PyTorch)
- Cloud experience (AWS/GCP)
- Degree in a quantitative field`,
  requiredSkills: 'Python, Machine Learning, SQL, Statistics, Pandas, Scikit-learn',
  preferredSkills: 'Deep Learning, TensorFlow, AWS, A/B Testing',
  minExp: '2',
  eduReq: 'B.Sc, M.Sc',
};

/**
 * Step 1 of the recruiter flow: structured job setup + batch resume upload.
 */
export default function JobSetup({ job, setJob, files, setFiles, onScreen, error, roles, setRoles }) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef(null);

  function set(k, v) {
    setJob((j) => ({ ...j, [k]: v }));
  }

  const [extracting, setExtracting] = useState(false);
  const [slotHint, setSlotHint] = useState('');

  const MIME = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
  };

  // Lightweight quote-aware CSV record parser (display sniffing only —
  // the backend does the authoritative parse).
  function parseCsvRecords(text) {
    const records = [];
    let field = '', record = [], inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { record.push(field); field = ''; }
      else if (c === '\n') { record.push(field); records.push(record); record = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || record.length) { record.push(field); records.push(record); }
    return records;
  }

  async function sniffCsv(file) {
    const text = (await file.text()).replace(/^﻿/, '');
    const records = parseCsvRecords(text);
    return { rows: records.length > 1 ? records.length - 1 : 0 };
  }

  // One CSV dataset counts as min(rows, 20) resume slots toward the 20 cap.
  const slotsOf = (f) => (f._csvInfo ? Math.min(f._csvInfo.rows, 20) : 1);

  // Expand a .zip dataset into individual resume files (client-side, via JSZip).
  // Skips folders, macOS metadata and non-resume entries.
  async function expandZip(file) {
    const zip = await JSZip.loadAsync(file);
    const out = [];
    const entries = Object.values(zip.files);
    for (const entry of entries) {
      if (entry.dir) continue;
      const base = entry.name.split('/').pop();
      if (!base || base.startsWith('.') || base.startsWith('__MACOSX')) continue;
      const m = /\.([^.]+)$/.exec(base);
      const ext = (m && m[1] || '').toLowerCase();
      if (!/^(pdf|docx?|doc)$/.test(ext)) continue;
      const blob = await entry.async('blob');
      out.push(new File([blob], base, { type: MIME[ext] || 'application/octet-stream' }));
    }
    return out;
  }

  async function addFiles(list) {
    const raw = Array.from(list || []);
    if (!raw.length) return;
    setSlotHint('');
    let incoming = [];
    const zips = raw.filter((f) => /\.zip$/i.test(f.name));
    const csvs = raw.filter((f) => /\.csv$/i.test(f.name));
    incoming = raw.filter((f) => /\.(pdf|docx?|doc)$/i.test(f.name));
    if (zips.length) {
      setExtracting(true);
      try {
        for (const z of zips) {
          const expanded = await expandZip(z);
          incoming = incoming.concat(expanded);
        }
      } catch {
        // corrupt zip: ignore it, keep any valid files already collected
      } finally {
        setExtracting(false);
      }
    }
    if (csvs.length) {
      setExtracting(true);
      try {
        for (const c of csvs) {
          try {
            const { rows } = await sniffCsv(c);
            c._csvInfo = { rows };
          } catch {
            c._csvInfo = { rows: 0 };
          }
          incoming.push(c);
        }
      } finally {
        setExtracting(false);
      }
    }
    if (!incoming.length) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name + f.size));
      const merged = [...prev];
      let used = prev.reduce((n, f) => n + slotsOf(f), 0);
      let skipped = false;
      for (const f of incoming) {
        if (names.has(f.name + f.size)) continue;
        if (used + slotsOf(f) > 20) { skipped = true; continue; }
        names.add(f.name + f.size);
        merged.push(f);
        used += slotsOf(f);
      }
      if (skipped) setSlotHint('Batch is full (20 resumes) — remove something to add more.');
      return merged;
    });
  }

  function removeFile(i) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function fillDemo() {
    setJob((j) => ({ ...j, ...DEMO_JOB }));
  }

  const totalKB = files.reduce((a, f) => a + f.size, 0) / 1024;
  const totalSlots = files.reduce((n, f) => n + slotsOf(f), 0);

  return (
    <>
    <div className="setup-grid">
      <section className="card rise" style={{ '--d': '0ms' }}>
        <div className="card-eyebrow">Job setup</div>
        <h2>Describe the role</h2>
        <p className="hint">The screener compares every resume against this. The more specific the skills, the sharper the ranking.</p>

        <div className="demo-fill-row">
          <Button type="button" className="btn-ghost btn-sm" onClick={fillDemo} title="Fill the form with a sample job posting">
            <Zap size={14} /> Fill demo job details
          </Button>
          <span className="hint">Upload your resumes, then click to fill the role fields with a sample posting.</span>
        </div>

        <div className="form-row">
          <Field label="Job title *">
            <input type="text" value={job.title} onChange={(e) => set('title', e.target.value)}
              placeholder="e.g. Senior Backend Engineer" />
          </Field>
          <Field label="Company">
            <input type="text" value={job.company} onChange={(e) => set('company', e.target.value)}
              placeholder="e.g. Acme Technologies" />
          </Field>
        </div>

        <Field label="Job description *" hint="Paste the full posting — responsibilities, must-haves, nice-to-haves.">
          <textarea rows={7} value={job.jdText} onChange={(e) => set('jdText', e.target.value)}
            placeholder="We are hiring a Senior Backend Engineer to build payment microservices. Must have: Python, Django, PostgreSQL, Docker…" />
        </Field>

        <Field label="Required skills" hint="Comma-separated. These carry half of the score.">
          <input type="text" value={job.requiredSkills} onChange={(e) => set('requiredSkills', e.target.value)}
            placeholder="e.g. Python, Django, PostgreSQL, Docker, REST APIs" />
        </Field>

        <Field label="Preferred skills (optional)" hint="Nice-to-haves — shown in each candidate's report, not scored.">
          <input type="text" value={job.preferredSkills} onChange={(e) => set('preferredSkills', e.target.value)}
            placeholder="e.g. Kubernetes, Redis, AWS" />
        </Field>

        <div className="form-row">
          <Field label="Minimum experience (years)">
            <input type="number" min="0" step="0.5" value={job.minExp}
              onChange={(e) => set('minExp', e.target.value)} placeholder="e.g. 3" />
          </Field>
          <Field label="Education requirements (optional)" hint="Comma-separated degree keywords.">
            <input type="text" value={job.eduReq} onChange={(e) => set('eduReq', e.target.value)}
              placeholder="e.g. B.Tech, MCA" />
          </Field>
        </div>
      </section>

      <section className="card rise" style={{ '--d': '80ms' }}>
        <div className="card-eyebrow">Resumes</div>
        <h2>Upload resumes</h2>
        <p className="hint">Add one resume — or a whole batch. Each file runs through the full screening pipeline.</p>

        <div
          role="button" tabIndex={0} aria-label="Upload resumes"
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}
          className={`dropzone ${dragOver ? 'over' : ''}`}
          onClick={() => fileInput.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        >
          <input ref={fileInput} type="file" accept=".pdf,.docx,.doc,.zip,.csv" multiple hidden
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <div className="dz-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="M9 15l3-3 3 3" />
            </svg>
          </div>
          <div className="dz-text"><strong>Drop resumes here</strong> or click to browse</div>
          <div className="dz-sub">PDF, Word, .zip, or a Kaggle CSV dataset · up to 10 MB each · max 20 resumes{extracting ? ' · reading…' : ''}</div>
        </div>
        {slotHint && <div className="hint" role="status">{slotHint}</div>}

        {files.length > 0 && (
          <div className="file-list">
            {files.map((f, i) => (
              <div key={f.name + f.size} className="file-row">
                <span className="file-badge">{f.name.split('.').pop().toUpperCase()}</span>
                <span className="file-name">{f.name}</span>
                <span className="file-size">
                  {f._csvInfo
                    ? `${f._csvInfo.rows} row${f._csvInfo.rows === 1 ? '' : 's'}${f._csvInfo.rows > 20 ? ' → first 20 screened' : ''}`
                    : `${(f.size / 1024).toFixed(0)} KB`}
                </span>
                <Button type="button" className="file-remove" onClick={() => removeFile(i)} aria-label={`Remove ${f.name}`} title={`Remove ${f.name}`}>✕</Button>
              </div>
            ))}
            <div className="file-total">{totalSlots} resume{totalSlots === 1 ? '' : 's'} · {totalKB.toFixed(0)} KB total</div>
          </div>
        )}

        {error && <div className="alert" role="alert">{error}</div>}

        <Button className="cta" type="button" onClick={onScreen} disabled={files.length === 0}>
          Screen {files.length > 0 ? `${totalSlots} resume${totalSlots === 1 ? '' : 's'}` : 'resumes'} →
        </Button>
        <p className="cta-hint">You will watch each resume being analysed, then get a ranked shortlist.</p>
      </section>
    </div>
    <div className="card rise" style={{ '--d': '160ms', marginTop: 16 }}>
      <div className="card-eyebrow">Job roles · dataset Express mode</div>
      <h2>Roles to score against</h2>
      <p className="hint">
        Standard screening uses the single role above. When you upload a large CSV dataset
        (over 20 rows), Express mode scores <strong>every resume against every role below</strong> —
        the whole dataset in under 45 seconds.
      </p>
      <div className="roles-list">
        {roles.map((role, i) => (
          <RoleCard
            key={i}
            role={role}
            index={i}
            canRemove={roles.length > 1}
            onChange={(idx, next) => setRoles(roles.map((r, j) => (j === idx ? next : r)))}
            onRemove={(idx) => setRoles(roles.filter((_, j) => j !== idx))}
          />
        ))}
      </div>
      {roles.length < 8 && (
        <Button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => setRoles([...roles, { title: '', requiredSkills: '', minExp: 2 }])}
        >
          ＋ Add job role
        </Button>
      )}
    </div>
    </>
  );
}
