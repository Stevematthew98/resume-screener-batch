import React, { useEffect, useRef, useState } from 'react';
import Button from './Button';
import StageWorkbench from './studio/StageWorkbench';
import { GROUPS, STAGES_ENRICHED } from './studio/studioStages';
import { STAGE_ORDER } from '../api';
import {
  BookOpen, Brain, Briefcase, Calculator, CaseSensitive, CheckCircle2, ClipboardList,
  FileInput, FileText, Filter, Flag, GitCompareArrows, LayoutList, MessageSquareText,
  Network, ScanSearch, Scissors, Sparkles, Tags, TriangleAlert, Trophy,
} from 'lucide-react';

const ICONS = {
  FileInput, FileText, Sparkles, CaseSensitive, Scissors, Tags, Filter, BookOpen,
  LayoutList, ScanSearch, Brain, Briefcase, ClipboardList, Network, GitCompareArrows,
  Calculator, Trophy, TriangleAlert, MessageSquareText, Flag,
};

const toSpec = (s) => s === 'done' ? 'completed' : s === 'active' ? 'processing' : s === 'pending' ? 'waiting' : 'failed';

function fmtDur(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function NlpStudio({
  total, doneCount, currentFile, resumes, candidates, ranking,
  job, error, startedAt, batchComplete, onViewRanking,
}) {
  const [selResumeKey, setSelResumeKey] = useState(null);
  const [pinnedStage, setPinnedStage] = useState(null);
  const [showSummary, setShowSummary] = useState(true);
  const [replayN, setReplayN] = useState(null); // null = not replaying; else stage number 1..20
  const [walkN, setWalkN] = useState(null); // paced guided walk: 1..20 while the live run is presented stage-by-stage
  const [autoNav, setAutoNav] = useState(false); // countdown to auto-open the final result
  const [autoNavSecs, setAutoNavSecs] = useState(5);
  const [now, setNow] = useState(Date.now());
  const batchDoneAt = useRef(null); // captured once when the batch completes
  const autoNavDone = useRef(false); // auto-open fires once per run
  const viewRankingRef = useRef(onViewRanking);
  viewRankingRef.current = onViewRanking;

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // New run → reset studio UI state and start the guided walk at stage 1.
  useEffect(() => {
    setReplayN(null);
    setPinnedStage(null);
    setSelResumeKey(null);
    setShowSummary(true);
    setWalkN(1);
    setAutoNav(false);
    batchDoneAt.current = null;
    autoNavDone.current = false;
  }, [startedAt]);

  // Capture the batch completion timestamp once (not the ticking clock).
  useEffect(() => {
    if (batchComplete && batchDoneAt.current == null) batchDoneAt.current = Date.now();
  }, [batchComplete]);

  // Guided replay: walk the RECORDED stages, ~3s each ≈ 60 seconds total.
  // All data shown is from this run's real outputs — clearly labeled as replay.
  useEffect(() => {
    if (replayN == null) return;
    if (replayN >= 20) {
      const t = setTimeout(() => setReplayN(null), 2500);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setReplayN(replayN + 1), 3000);
    return () => clearTimeout(t);
  }, [replayN]);

  const running = resumes.find((r) => r.status === 'running');
  const selected = (selResumeKey && resumes.find((r) => r.key === selResumeKey)) || running || resumes[0] || null;

  // Execution state per real backend stage for the selected resume.
  const exec = {};
  if (selected) {
    selected.stages.forEach((s) => {
      exec[s.key] = { status: s.status, completedAt: s.completedAt || null, detail: s.detail || null, summary: s.summary };
    });
  }
  exec.__batch__ = {
    status: batchComplete ? 'done' : (selected && selected.status === 'done' ? 'active' : 'pending'),
    completedAt: batchComplete ? batchDoneAt.current : null, detail: null,
  };

  // Real per-stage durations from completion timestamps.
  const durations = {};
  let prev = (selected && selected.startedAt) || startedAt;
  [...STAGE_ORDER, '__batch__'].forEach((k) => {
    const e = exec[k];
    if (e && e.completedAt && prev) durations[k] = e.completedAt - prev;
    if (e && e.completedAt) prev = e.completedAt;
  });

  const failed = selected && selected.status === 'error';

  // Batch mode: ONE guided walk per batch (not per resume). The walk follows
  // the live backend — stage readiness is gated on the currently RUNNING
  // resume, so the walk tracks the batch as a whole instead of restarting
  // for every file. The workbench auto-follows the running resume.
  const walkResume = running || resumes[0] || null;
  function stageReady(execKey) {
    if (execKey === '__batch__') return batchComplete;
    if (!walkResume) return false;
    if (walkResume.status === 'done') return true;
    const st = walkResume.stages.find((s) => s.key === execKey);
    return !!(st && st.status === 'done');
  }

  // Guided walk director: one stage at a time, ~3 seconds each (≈60s total).
  // A stage is only marked done once its REAL backend output is recorded —
  // if the backend is slower than the walk, we wait honestly instead of faking.
  //
  // Timing design (two hard-won lessons):
  //  - `now` ticks every second, and every SSE event gives `selected` a new
  //    reference — neither may own the advance timer, or it gets cancelled
  //    forever / restarted on every backend event. So a steady 500ms interval
  //    checks progress, and the per-stage 3s viewing window lives in a ref
  //    that only resets when the walk actually moves to the next stage.
  const walkStageStart = useRef(null);
  useEffect(() => {
    walkStageStart.current = null;
    if (walkN != null && walkN > 20) setWalkN(null); // walk finished → hand over to summary
  }, [walkN]);
  useEffect(() => {
    const t = setInterval(() => {
      if (walkN == null || walkN > 20) return;
      if (failed) { setWalkN(null); return; }
      const stage = STAGES_ENRICHED[walkN - 1];
      if (!stageReady(stage.execKey)) { walkStageStart.current = null; return; }
      if (walkStageStart.current == null) walkStageStart.current = Date.now();
      if (Date.now() - walkStageStart.current >= 3000) {
        walkStageStart.current = null;
        // 20 → null directly: walkN must NEVER render as 21, because the
        // header reads STAGES_ENRICHED[walkN - 1].name and [20] is undefined
        // → TypeError → blank page (this exact crash blanked the studio once).
        setWalkN((n) => (n == null || n >= 20 ? null : n + 1));
      }
    }, 500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkN, selected, batchComplete, startedAt, failed]);

  // Auto-follow the live stage unless the user pinned one.
  let autoStage = 1;
  if (selected) {
    const activeExec = selected.stages.find((s) => s.status === 'active');
    if (activeExec) {
      const first = STAGES_ENRICHED.find((st) => st.execKey === activeExec.key);
      if (first) autoStage = first.n;
    } else {
      const lastDone = [...selected.stages].reverse().find((s) => s.status === 'done');
      if (lastDone) {
        const group = STAGES_ENRICHED.filter((st) => st.execKey === lastDone.key);
        autoStage = group.length ? group[group.length - 1].n : 1;
      }
    }
  }
  // During the guided walk (not replay, not a pinned stage), the workbench
  // auto-shows the code block of whichever stage is currently in focus.
  const walkFocus = walkN != null && replayN == null && pinnedStage == null;
  const selStageN = replayN || pinnedStage || walkN || autoStage;
  const stage = STAGES_ENRICHED.find((s) => s.n === selStageN) || STAGES_ENRICHED[0];
  const stageExec = exec[stage.execKey] || { status: 'pending' };
  // Walk-aware status: during the guided walk the workbench reflects the stage
  // being presented — its real backend data is always recorded before it is
  // marked done, so "processing" here means "currently being shown in detail".
  const specStatus = (() => {
    if (failed) return 'failed';
    if (walkN != null && replayN == null) {
      if (stage.n < walkN) return 'completed';
      if (stage.n === walkN) return 'processing';
      return 'waiting';
    }
    return toSpec(stageExec.status);
  })();

  const candidate = selected && selected.resume_id ? candidates[selected.resume_id] : null;
  const rankIdx = selected && ranking ? ranking.findIndex((r) => r.resume_id === selected.resume_id) : -1;

  const ctx = {
    candidate, ranking: ranking || [], rank: rankIdx >= 0 ? rankIdx + 1 : null,
    job, resumeId: selected ? selected.resume_id : null,
  };

  // Progress header numbers.
  const walking = walkN != null;
  const pct = walking ? Math.round(((walkN - 1) / 20) * 100) : total ? Math.round((doneCount / total) * 100) : 0;
  const elapsed = startedAt ? now - startedAt : 0;
  const rate = elapsed > 0 && doneCount > 0 ? doneCount / elapsed : 0;
  const eta = rate > 0 && doneCount < total ? Math.round((total - doneCount) / rate) : null;
  const walkEta = walking ? (21 - walkN) * 3000 : null; // ≈3s per remaining stage
  const activeLabel = walking && walkN <= 20
    ? `Stage ${walkN} of 20 · ${STAGES_ENRICHED[walkN - 1].name}`
    : running
      ? (running.stages.find((s) => s.status === 'active') || {}).label || 'Working…'
      : batchComplete ? 'Complete' : 'Starting…';

  const summaryStats = (() => {
    if (!batchComplete) return null;
    const cands = Object.values(candidates || {});
    const scores = cands.map((c) => c.score || 0);
    return {
      resumes: doneCount,
      avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) : 0,
      strong: cands.filter((c) => c.band === 'Strong match').length,
      warnings: cands.reduce((a, c) => a + (c.warnings || []).length, 0),
      elapsed,
    };
  })();

  // After the walk finishes, open the final result automatically:
  // arm a 5s countdown once the completion summary appears. Exploring the
  // NLP results or replaying cancels it; the analysis buttons go immediately.
  function cancelAutoNav() {
    autoNavDone.current = true;
    setAutoNav(false);
  }
  function goToResults() {
    cancelAutoNav();
    viewRankingRef.current();
  }
  const summaryVisible = batchComplete && walkN == null && showSummary && !!summaryStats;
  useEffect(() => {
    if (summaryVisible && !autoNavDone.current && !autoNav) {
      setAutoNavSecs(5);
      setAutoNav(true);
    }
  }, [summaryVisible, autoNav]);
  useEffect(() => {
    if (!autoNav) return;
    if (autoNavSecs <= 0) {
      goToResults();
      return;
    }
    const t = setTimeout(() => setAutoNavSecs((s) => s - 1), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNav, autoNavSecs]);

  return (
    <div className="studio">
      {/* ---------- progress header ---------- */}
      <section className="card rise studio-top">
        <div className="studio-top-head">
          <div>
            <div className="card-eyebrow">TalentIQ · NLP Processing Studio · Batch mode</div>
            <h2>{total > 1 ? 'Analyzing Resumes' : 'Analyzing Resume'}</h2>
            <p className="hint">Extracting skills, processing language, and evaluating job alignment.</p>
          </div>
          <div className="studio-metrics">
            <div className="studio-metric"><span className="sm-k">Progress</span><span className="sm-v mono">{pct}%</span></div>
            <div className="studio-metric"><span className="sm-k">Elapsed</span><span className="sm-v mono">{fmtClock(elapsed)}</span></div>
            <div className="studio-metric"><span className="sm-k">Remaining</span><span className="sm-v mono">{walking ? `~${fmtClock(walkEta)}` : eta != null ? `~${fmtClock(eta)}` : '—'}</span></div>
            <div className="studio-metric"><span className="sm-k">Stage</span><span className="sm-v">{activeLabel}</span></div>
          </div>
        </div>
        <div className="progress-track" role="progressbar" aria-label="Overall screening progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="progress-meta">
          <span>{doneCount} of {total} resumes screened{currentFile ? <> · now reading <strong>{currentFile}</strong></> : ''}</span>
          <span>{walking ? `Guided walk · stage ${walkN} of 20` : batchComplete ? 'Complete' : 'Processing…'}</span>
        </div>
        {error && <div className="alert" role="alert">{error}</div>}
      </section>

      {/* ---------- completion summary (after the guided walk finishes) ---------- */}
      {summaryVisible && (
        <section className="card rise studio-done" style={{ '--d': '60ms' }}>
          <div className="card-eyebrow">Complete</div>
          <h2>NLP Analysis Complete</h2>
          <div className="viz-tiles">
            <div className="viz-tile"><div className="viz-tile-k">RESUMES PROCESSED</div><div className="viz-tile-v mono">{summaryStats.resumes}</div></div>
            <div className="viz-tile"><div className="viz-tile-k">AVG MATCH SCORE</div><div className="viz-tile-v mono">{summaryStats.avg}%</div></div>
            <div className="viz-tile"><div className="viz-tile-k">STRONG MATCHES</div><div className="viz-tile-v mono">{summaryStats.strong}</div></div>
            <div className="viz-tile"><div className="viz-tile-k">ELAPSED</div><div className="viz-tile-v mono">{fmtClock(summaryStats.elapsed)}</div></div>
            <div className="viz-tile"><div className="viz-tile-k">WARNINGS</div><div className="viz-tile-v mono">{summaryStats.warnings}</div></div>
          </div>
          {autoNav && (
            <p className="hint" role="status" style={{ margin: '10px 0 0' }}>
              Opening the final result in <strong className="mono">{autoNavSecs}s</strong>…
              Stay here to explore the NLP results or replay the pipeline.
            </p>
          )}
          <div className="studio-done-actions">
            <Button type="button" className="btn-primary btn-sm" onClick={goToResults}>View Candidate Analysis</Button>
            <Button type="button" className="btn-ghost btn-sm" onClick={() => { cancelAutoNav(); setShowSummary(false); }}>Explore NLP Results</Button>
            <Button type="button" className="btn-ghost btn-sm" onClick={() => { cancelAutoNav(); setShowSummary(false); setReplayN(1); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Replay pipeline (≈60 sec)</Button>
            <Button type="button" className="btn-ghost btn-sm" onClick={goToResults}>Return to Candidate Rankings</Button>
          </div>
        </section>
      )}

      {/* ---------- replay banner ---------- */}
      {replayN != null && (
        <section className="card rise studio-replay" aria-label="Pipeline replay">
          <div className="replay-head">
            <div>
              <div className="card-eyebrow">Guided replay · recorded run</div>
              <p className="hint" style={{ margin: 0 }}>
                {replayN <= 20
                  ? <>Replaying stage <strong>{replayN} of 20</strong> — {STAGES_ENRICHED[replayN - 1].name}. All values are this run’s real recorded outputs, not live processing.</>
                  : <>Replay complete — explore any stage freely.</>}
              </p>
            </div>
            <Button type="button" className="btn-ghost btn-sm" onClick={() => setReplayN(null)}>Stop replay</Button>
          </div>
          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${Math.min(100, (replayN / 20) * 100)}%` }} />
          </div>
        </section>
      )}

      {/* ---------- two panels ---------- */}
      <div className="studio-panels">
        {/* LEFT — pipeline execution */}
        <section className="card rise studio-left" style={{ '--d': '100ms' }} aria-label="NLP pipeline execution">
          <div className="card-eyebrow">NLP Processing Pipeline</div>
          <p className="hint">Follow your resume through every stage of intelligent analysis.</p>
          {resumes.length > 1 && (
            <div className="resume-tabs studio-tabs" role="tablist" aria-label="Choose a resume">
              {resumes.map((r) => (
                <Button key={r.key} type="button" role="tab" aria-selected={selected && r.key === selected.key}
                  className={`resume-tab ${r.status} ${selected && r.key === selected.key ? 'active' : ''}`}
                  onClick={() => { setSelResumeKey(r.key); setPinnedStage(null); }} title={r.filename}>
                  <span className={`tab-dot ${r.status}`} />
                  {r.filename.length > 18 ? `${r.filename.slice(0, 16)}…` : r.filename}
                </Button>
              ))}
            </div>
          )}
          <div className="pipe-groups">
            {GROUPS.map((g, gi) => (
              <div className="pipe-group" key={g}>
                <div className="pipe-group-label"><span>GROUP {gi + 1}</span> {g}</div>
                <div className="pipe-list">
                  {STAGES_ENRICHED.filter((s) => s.group === gi).map((s, idx, arr) => {
                    const e = exec[s.execKey] || { status: 'pending' };
                    // During the guided walk the left rail shows the presented
                    // state: done = real output recorded, current = in focus.
                    const st = (() => {
                      if (failed) return 'failed';
                      if (walkN != null && replayN == null) {
                        if (s.n < walkN) return 'completed';
                        if (s.n === walkN) return 'processing';
                        return 'waiting';
                      }
                      return toSpec(e.status);
                    })();
                    const Icon = ICONS[s.icon] || FileText;
                    const isSel = s.n === selStageN;
                    return (
                      <div key={s.n} className="pipe-row-wrap">
                        <Button type="button"
                          className={`pipe-row ${st} ${isSel ? 'selected' : ''}`}
                          onClick={() => setPinnedStage(isSel && pinnedStage ? null : s.n)}
                          aria-current={isSel}
                          title={`${s.name} — ${s.tagline}${s.sub ? ` (runs within ${s.parentName})` : ''}`}>
                          <span className="pipe-rail" aria-hidden="true">
                            <span className={`pipe-dot ${st}`}>{st === 'completed' ? '✓' : st === 'processing' ? <span className="step-spinner xs" /> : s.n}</span>
                            {idx < arr.length - 1 && <span className="pipe-vline" />}
                          </span>
                          <span className="pipe-row-main">
                            <span className="pipe-row-top">
                              <Icon size={14} className="pipe-icon" />
                              <span className="pipe-name">{s.n}. {s.name}</span>
                              {s.sub && <span className="pipe-sub-tag" title={`Runs within ${s.parentName}`}>⊂</span>}
                            </span>
                            <span className="pipe-tagline">{s.tagline}</span>
                          </span>
                          <span className="pipe-row-meta">
                            <span className={`st-badge ${st}`}>{st}</span>
                            {!s.sub || s.firstOfExec ? (
                              durations[s.execKey] != null && <span className="mono pipe-dur">{fmtDur(durations[s.execKey])}</span>
                            ) : null}
                          </span>
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {pinnedStage && replayN == null && (
            <Button type="button" className="btn-ghost btn-sm studio-live-btn" onClick={() => setPinnedStage(null)}>
              <CheckCircle2 size={14} /> Following live
            </Button>
          )}
        </section>

        {/* RIGHT — stage intelligence */}
        <section className="card rise studio-right" style={{ '--d': '140ms' }} aria-label="Stage intelligence">
          <div className="card-eyebrow">Stage Intelligence</div>
          <p className="hint">Explore the actual transformations performed on your resume.{selected ? <> — <strong>{selected.filename}</strong></> : ''}</p>
          <StageWorkbench
            stage={stage}
            execStatus={specStatus}
            durationMs={(!stage.sub || stage.firstOfExec) ? durations[stage.execKey] : null}
            detail={(exec[stage.execKey] || {}).detail}
            ctx={ctx}
            showCodeLive={walkFocus && stage.n === walkN}
          />
        </section>
      </div>
    </div>
  );
}
