import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';

const TABS = ['Overview', 'Input / Output', 'Python Code', 'Technical Details'];

function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function StatusBadge({ status }) {
  return <span className={`st-badge ${status}`}>{status}</span>;
}

/* ---------------- code explorer ---------------- */

function CodeExplorer({ code, live }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = code.code.split('\n');
  // During the guided walk the current stage's code is shown expanded automatically.
  const expanded = live || open;
  async function copy() {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }
  return (
    <div className={`code-explorer ${live ? 'live' : ''}`}>
      <button type="button" className="code-head" onClick={() => setOpen(!open)} aria-expanded={expanded}>
        <span className="code-title">{code.title}</span>
        {live && <span className="live-pill"><span className="live-dot" />in focus</span>}
        <span className={`code-src ${/illustrative/i.test(code.note) ? 'demo' : 'real'}`}>
          {/illustrative/i.test(code.note) ? 'illustrative' : 'actual backend'}
        </span>
        <ChevronDown size={16} className={`chev ${expanded ? 'open' : ''}`} />
      </button>
      <div className="code-meta">
        <span><strong>Library:</strong> {code.library}</span>
        <span><strong>Algorithm:</strong> {code.algorithm}</span>
      </div>
      <p className="hint code-note">{code.note}</p>
      {expanded && (
        <div className="code-body">
          <button type="button" className="code-copy" onClick={copy} title="Copy code">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <pre className="code-pre"><code>
            {lines.map((ln, i) => (
              <span className="code-line" key={i}>
                <span className="code-ln">{i + 1}</span>
                <span>{ln || ' '}</span>
              </span>
            ))}
          </code></pre>
        </div>
      )}
    </div>
  );
}

/* ---------------- main workbench ---------------- */

function IoBox({ title, rows, text }) {
  return (
    <div className="io-box">
      <div className="io-title">{title}</div>
      {rows && rows.map(([k, v]) => (
        <div className="drow" key={k}>
          <span className="dkey">{k}</span>
          <span className="dval">{v}</span>
        </div>
      ))}
      {text && <pre className="io-text">{text}</pre>}
    </div>
  );
}

export default function StageWorkbench({ stage, execStatus, durationMs, detail, ctx, showCodeLive }) {
  const [tab, setTab] = useState('Overview');
  const stageN = stage ? stage.n : null;
  // During the guided walk, each stage's working is shown with its code block:
  // when a new stage comes into focus, switch to its Python Code tab automatically.
  // The user can still pick any tab freely mid-stage — we only auto-switch on stage change.
  useEffect(() => {
    if (showCodeLive && stageN != null) setTab('Python Code');
  }, [stageN, showCodeLive]);
  if (!stage) {
    return (
      <div className="workbench empty">
        <p className="hint">Select a stage on the left to inspect its working.</p>
      </div>
    );
  }
  const io = stage.io(detail, ctx);

  return (
    <div className="workbench">
      <div className="wb-head">
        <div>
          <div className="wb-eyebrow">Stage {String(stage.n).padStart(2, '0')} · {stage.groupName}</div>
          <h3>{stage.name}</h3>
        </div>
        <div className="wb-badges">
          <StatusBadge status={execStatus} />
          <span className="wb-dur mono" title="Execution duration">{fmtDur(durationMs)}</span>
        </div>
      </div>

      <div className="wb-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            className={`wb-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      <div className="wb-body">
        {tab === 'Overview' && (
          <div>
            <p className="wb-purpose">{stage.purpose}</p>
            <div className="io-grid">
              <IoBox title="Input" rows={[['TYPE', stage.inputType]]} />
              <IoBox title="Output" rows={[['TYPE', stage.outputType]]} />
            </div>
            {stage.sub && <p className="hint sub-note">Runs inside “{stage.parentName}” — shares its execution and timing, shown separately for clarity.</p>}
            {execStatus === 'waiting' && <p className="hint">Waiting for the pipeline to reach this stage…</p>}
            {execStatus === 'processing' && <p className="hint">This stage is processing right now — details appear as it completes.</p>}
          </div>
        )}

        {tab === 'Input / Output' && (
          execStatus === 'waiting'
            ? <p className="hint">No data yet — the pipeline hasn’t reached this stage.</p>
            : <div className="io-grid">
              <IoBox title={`Input — ${io.input.title}`} rows={io.input.rows} text={io.input.text} />
              <IoBox title={`Output — ${io.output.title}`} rows={io.output.rows} text={io.output.text} />
            </div>
        )}

        {tab === 'Python Code' && <CodeExplorer code={stage.code} live={!!showCodeLive} />}

        {tab === 'Technical Details' && (
          <ul className="viz-list">
            <li><strong>Backend stage:</strong> <span className="mono">{stage.execKey}</span>{stage.sub ? ' (shared execution)' : ''}</li>
            {stage.tech.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
