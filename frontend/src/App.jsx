import React, { useCallback, useEffect, useState } from 'react';
import Button from './components/Button';
import { LayoutDashboard, BriefcaseBusiness, History, ScanLine, LogOut, Menu, X, ChevronRight, ShieldCheck, Plus } from 'lucide-react';
import {
  blankStages,
  createJob,
  downloadExport,
  getCandidateStatuses,
  getDashboard,
  getMe,
  getSessionDetail,
  getToken,
  listJobs,
  listSessions,
  logout as apiLogout,
  setCandidateStatus,
  streamScreen,
  screenExpress,
} from './api';
import Dashboard from './components/Dashboard';
import Backdrop from './components/Backdrop';import HistoryView from './components/HistoryView';
import JobsView from './components/JobsView';
import JobSetup, { DEFAULT_ROLES } from './components/JobSetup';
import ExpressResults from './components/ExpressResults';
import Login from './components/Login';
import NlpStudio from './components/NlpStudio';
import RankingView, { CandidateDetail } from './components/RankingView';

const EMPTY_JOB = {
  title: '',
  company: '',
  jdText: '',
  requiredSkills: '',
  preferredSkills: '',
  minExp: '',
  eduReq: '',
};

function toJobPayload(job) {
  return {
    title: job.title.trim(),
    company: job.company.trim(),
    jd_text: job.jdText.trim(),
    required_skills: job.requiredSkills,
    preferred_skills: job.preferredSkills,
    min_experience_years: job.minExp === '' ? 0 : Number(job.minExp) || 0,
    education_requirements: job.eduReq.trim(),
  };
}

function jobToForm(j) {
  return {
    title: j.title || '',
    company: j.company || '',
    jdText: j.jd_text || '',
    requiredSkills: (j.required_skills || []).join(', '),
    preferredSkills: (j.preferred_skills || []).join(', '),
    minExp: j.min_experience_years ? String(j.min_experience_years) : '',
    eduReq: j.education_requirements || '',
  };
}

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [navOpen, setNavOpen] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');
  const [view, setView] = useState('dashboard'); // dashboard | jobs | history | setup | screening | ranking | historyDetail | express
  const [job, setJob] = useState(EMPTY_JOB);
  const [files, setFiles] = useState([]);
  const [error, setError] = useState('');
  const [roles, setRoles] = useState(DEFAULT_ROLES);
  const [express, setExpress] = useState(null); // {status, total, roles, startedAt, result, error}
  const [activeJobId, setActiveJobId] = useState(null);

  const [total, setTotal] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [currentFile, setCurrentFile] = useState('');
  const [pipes, setPipes] = useState([]);
  const [screenError, setScreenError] = useState('');
  const [screeningStartedAt, setScreeningStartedAt] = useState(null);
  const [batchComplete, setBatchComplete] = useState(false);

  const [ranking, setRanking] = useState([]);
  const [candidates, setCandidates] = useState({});
  const [statuses, setStatuses] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [sessionId, setSessionId] = useState(null);

  const [jobs, setJobs] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [dashData, setDashData] = useState(null);
  const [historyDetail, setHistoryDetail] = useState(null);

  function handleSessionExpired() {
    apiLogout();
    setUser(null);
    setView('dashboard');
  }

  const guard = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e.sessionExpired) handleSessionExpired();
      throw e;
    }
  }, []);

  // Restore session on load
  useEffect(() => {
    if (!getToken()) { setAuthChecked(true); return; }
    getMe()
      .then((u) => setUser(u))
      .catch(() => apiLogout())
      .finally(() => setAuthChecked(true));
  }, []);

  const refreshJobs = useCallback(() => guard(() => listJobs().then(setJobs)), [guard]);
  const refreshSessions = useCallback(() => guard(() => listSessions().then(setSessions)), [guard]);
  const refreshDashboard = useCallback(() => guard(() => getDashboard().then(setDashData)), [guard]);

  useEffect(() => {
    if (user) {
      setDataLoading(true);
      setDataError('');
      Promise.all([refreshDashboard(), refreshJobs(), refreshSessions()])
        .catch(() => setDataError('Could not load your workspace. Check the screening service and try again.'))
        .finally(() => setDataLoading(false));
    }
  }, [user, refreshDashboard, refreshJobs, refreshSessions]);

  function updatePipe(key, fn) {
    setPipes((prev) => prev.map((p) => (p.key === key ? fn(p) : p)));
  }

  function goSetup(prefillJob) {
    if (prefillJob) {
      setJob(jobToForm(prefillJob));
      setActiveJobId(prefillJob.id);
    } else {
      setJob(EMPTY_JOB);
      setActiveJobId(null);
    }
    setFiles([]);
    setError('');
    setView('setup');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function startScreening() {
    setError('');
    if (!files.length) { setError('Please upload at least one resume.'); return; }

    // Express dataset mode: a CSV with more than 20 rows is scored against
    // every job role in one rapid scan (whole dataset, under 45 seconds).
    const bigCsv = files.find((f) => f._csvInfo && f._csvInfo.rows > 20);
    if (bigCsv) {
      const cleanRoles = roles
        .map((r) => ({
          title: (r.title || '').trim(),
          requiredSkills: (r.requiredSkills || '').trim(),
          minExp: r.minExp,
        }))
        .filter((r) => r.title && r.requiredSkills);
      if (!cleanRoles.length) {
        setError('Add at least one job role with a title and required skills for the dataset scan.');
        return;
      }
      const payload = cleanRoles.map((r) => ({
        title: r.title,
        required_skills: r.requiredSkills.split(',').map((s) => s.trim()).filter(Boolean),
        min_experience_years: parseFloat(r.minExp) || 0,
      }));
      setExpress({
        status: 'running',
        total: bigCsv._csvInfo.rows,
        roles: payload.map((r) => r.title),
        startedAt: Date.now(),
        result: null,
        error: '',
      });
      setView('express');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      try {
        await guard(() => screenExpress(bigCsv, payload, (evt) => {
          if (evt.type === 'express_done') {
            setExpress((prev) => ({ ...prev, status: 'done', result: evt }));
          }
        }));
        // The scan is now persisted — dashboard and history reflect it immediately.
        refreshDashboard().catch(() => {});
        refreshSessions().catch(() => {});
      } catch (e) {
        if (!e.sessionExpired) {
          setExpress((prev) => (prev ? { ...prev, status: 'error', error: e.message || 'Express scan failed.' } : prev));
        }
      }
      return;
    }

    if (!job.title.trim()) { setError('Please give the role a job title.'); return; }
    if (!job.jdText.trim()) { setError('Please paste the job description.'); return; }

    const payload = toJobPayload(job);
    let jobId = activeJobId;
    try {
      // Auto-save ad-hoc jobs so every run is linked to a job profile + history.
      if (!jobId) {
        const created = await guard(() => createJob(payload));
        jobId = created.id;
        setActiveJobId(jobId);
        refreshJobs().catch(() => {});
      }
    } catch (e) {
      setError(e.message || 'Could not save the job profile.');
      return;
    }

    setPipes(files.map((f, i) => ({ key: `f${i}`, filename: f.name, resume_id: null, stages: blankStages(), status: 'queued', startedAt: null })));
    setTotal(files.length);
    setDoneCount(0);
    setCurrentFile('');
    setScreenError('');
    setRanking([]);
    setCandidates({});
    setStatuses({});
    setSessionId(null);
    setScreeningStartedAt(Date.now());
    setBatchComplete(false);
    setView('screening');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const byIndex = {};
    try {
      await streamScreen(files, payload, (evt) => {
        if (evt.type === 'job_ready') {
          setTotal(evt.total);
          if (evt.session_id) setSessionId(evt.session_id);
        } else if (evt.type === 'resume_start') {
          const key = `f${evt.index}`;
          byIndex[evt.index] = evt.resume_id;
          setCurrentFile(evt.filename);
          updatePipe(key, (p) => ({
            ...p,
            resume_id: evt.resume_id,
            status: 'running',
            startedAt: Date.now(),
            stages: p.stages.map((s, i) => (i === 0 ? { ...s, status: 'active' } : s)),
          }));
        } else if (evt.type === 'stage') {
          const key = `f${evt.index}`;
          updatePipe(key, (p) => ({
            ...p,
            stages: p.stages.map((s) => {
              if (s.key === evt.stage) return { ...s, status: 'done', summary: evt.summary, detail: evt.detail || null, completedAt: Date.now() };
              if (s.status === 'active') return { ...s, status: 'done', summary: s.summary, completedAt: s.completedAt || Date.now() };
              return s;
            }).map((s, i, arr) => {
              const doneIdx = arr.findIndex((x) => x.key === evt.stage);
              if (i === doneIdx + 1 && s.status === 'pending') return { ...s, status: 'active' };
              return s;
            }),
          }));
        } else if (evt.type === 'resume_done') {
          const key = `f${evt.index}`;
          setCandidates((prev) => ({ ...prev, [evt.resume_id]: evt.candidate }));
          setStatuses((prev) => ({
            ...prev,
            [evt.resume_id]: { status: 'Screened', notes: '', reject_reason: '', filename: evt.filename },
          }));
          updatePipe(key, (p) => ({
            ...p,
            status: 'done',
            stages: p.stages.map((s) => (s.status === 'done' ? s : { ...s, status: 'done', summary: s.summary })),
          }));
          setDoneCount((c) => c + 1);
        } else if (evt.type === 'resume_error') {
          const key = `f${evt.index}`;
          updatePipe(key, (p) => ({ ...p, status: 'error' }));
          setDoneCount((c) => c + 1);
        } else if (evt.type === 'batch_complete') {
          setRanking(evt.ranking || []);
          setBatchComplete(true);
          if (evt.session_id) setSessionId(evt.session_id);
          getCandidateStatuses(evt.session_id).then((sv) => {
            setStatuses((prev) => ({ ...sv, ...prev }));
          }).catch(() => {});
          refreshDashboard().catch(() => {});
          refreshSessions().catch(() => {});
          // Stay on the studio: the completion summary offers
          // View Candidate Analysis / Explore NLP Results / replay actions.
        }
      }, { jobId });
    } catch (e) {
      if (e.sessionExpired) { handleSessionExpired(); return; }
      setScreenError(e.message || 'Screening failed. Please try again.');
    }
  }

  async function handleStatusChange(resume_id, status, notes, reject_reason) {
    const updated = await guard(() => setCandidateStatus(resume_id, status, notes, reject_reason));
    setStatuses((prev) => ({
      ...prev,
      [resume_id]: { status: updated.status, notes: updated.notes, reject_reason: updated.reject_reason, filename: updated.filename },
    }));
    if (historyDetail) {
      setHistoryDetail((prev) => prev && ({
        ...prev,
        candidates: {
          ...prev.candidates,
          [resume_id]: prev.candidates[resume_id]
            ? { ...prev.candidates[resume_id], status: updated.status, notes: updated.notes, reject_reason: updated.reject_reason }
            : prev.candidates[resume_id],
        },
      }));
    }
  }

  async function openSession(id) {
    try {
      const detail = await guard(() => getSessionDetail(id));
      if (detail.method === 'express') {
        // Reopen an express dataset scan with its role-tab rankings.
        setExpress({ status: 'done', result: detail, total: detail.total_resumes,
                     roles: detail.roles, startedAt: null });
        setView('express');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const st = {};
      (detail.ranking || []).forEach((r) => {
        st[r.resume_id] = { status: r.status || 'Screened', notes: r.notes || '', reject_reason: r.reject_reason || '', filename: r.filename };
      });
      setStatuses(st);
      setHistoryDetail(detail);
      setSelectedId(null);
      setView('historyDetail');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      alert(e.message || 'Could not open the session.');
    }
  }

  async function handleExport(kind) {
    const id = sessionId || (historyDetail && historyDetail.id);
    if (!id) return;
    await guard(() => downloadExport(id, kind));
  }

  function handleLogout() {
    apiLogout();
    setUser(null);
    setView('dashboard');
    setDashData(null);
    setJobs([]);
    setSessions([]);
  }

  function restart() {
    setView('setup');
    setJob(EMPTY_JOB);
    setActiveJobId(null);
    setFiles([]);
    setRanking([]);
    setCandidates({});
    setStatuses({});
    setSelectedId(null);
    setSessionId(null);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const selected = selectedId ? (candidates[selectedId] || (historyDetail && historyDetail.candidates[selectedId])) : null;
  const selectedStatus = selectedId
    ? (statuses[selectedId] || { status: (selected && selected.status) || 'Screened', notes: '', reject_reason: '' })
    : null;
  const isHistoryDetail = view === 'historyDetail';

  if (!authChecked) {
    return <div className="auth-loading" role="status"><ScanLine size={28} /><p>Opening your workspace…</p></div>;
  }

  if (!user) {
    return (
      <div className="page">
        <Backdrop />
        <Login onAuth={(u) => { setUser(u); setView('dashboard'); }} />
      </div>
    );
  }

  const nav = [
    ['setup', 'New screening'],
    ['dashboard', 'Dashboard'],
    ['history', 'History'],
    ['jobs', 'Jobs'],
  ];

  return (
    <div className="app-shell">
      <Backdrop />
      <a className="skip-link" href="#workspace-content">Skip to content</a>
      {navOpen && <Button className="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
      <aside className={`app-sidebar ${navOpen ? 'is-open' : ''}`}>
        <div className="sidebar-brand"><span className="brand-mark"><ScanLine size={22} /></span><div>Resume Screener<span>Recruitment workspace</span></div><Button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setNavOpen(false)}><X size={20} /></Button></div>
        <div className="nav-label">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {nav.map(([v, label]) => {
            const Icon = v === 'dashboard' ? LayoutDashboard : v === 'jobs' ? BriefcaseBusiness : v === 'setup' ? Plus : History;
            const active = view === v || (v === 'history' && isHistoryDetail) || (v === 'setup' && ['setup', 'screening', 'ranking', 'express'].includes(view));
            return <Button key={v} className={`nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={() => {
              setNavOpen(false);
              if (v === 'setup') { goSetup(null); return; }
              setDataError(''); setDataLoading(true);
              const request = v === 'dashboard' ? refreshDashboard() : v === 'jobs' ? refreshJobs() : refreshSessions();
              request.catch(() => setDataError('Could not load this page. Please check the screening service.')).finally(() => setDataLoading(false));
              setView(v); window.scrollTo({ top: 0, behavior: 'smooth' });
            }}><Icon size={19} /><span>{label}</span>{active && <ChevronRight size={16} />}</Button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-trust"><ShieldCheck size={19} /><div>Evidence-led hiring<span>Human decisions. Always.</span></div></div>
          <div className="sidebar-account"><span className="account-avatar">{(user.name || user.email || 'R').charAt(0).toUpperCase()}</span><div><strong>{user.name || 'Recruiter'}</strong><span>{user.email}</span></div><Button className="icon-button" onClick={handleLogout} aria-label="Sign out" title="Sign out"><LogOut size={18} /></Button></div>
        </div>
      </aside>
      <div className="app-main">
        <header className="workspace-topbar">
          <div className="breadcrumb"><Button className="mobile-menu icon-button" aria-label="Open navigation" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu size={21} /></Button><span>Workspace</span><ChevronRight size={14} /><strong>{({dashboard: 'Dashboard', jobs: 'Job profiles', history: 'Screening history', setup: 'New screening', screening: 'Live screening', ranking: 'Screening results', historyDetail: 'Session results'})[view]}</strong></div>
      </header>
        <main id="workspace-content" className="workspace-content">
          {dataError && <div className="form-error" role="alert">{dataError}</div>}
      {view === 'dashboard' && (
        <Dashboard
          data={dashData} loading={dataLoading} error={dataError}
          onNewScreening={() => goSetup(null)}
          onOpenSession={openSession}
        />
      )}

      {view === 'jobs' && (
        <JobsView
          jobs={jobs} loading={dataLoading} error={dataError}
          onRefresh={refreshJobs}
          onScreenJob={(j) => goSetup(j)}
          onNewJob={() => goSetup(null)}
        />
      )}

      {view === 'history' && (
        <HistoryView sessions={sessions} loading={dataLoading} error={dataError} onOpenSession={openSession} />
      )}

      {view === 'setup' && (
        <>
          <div className="dash-head"><div><h2>New screening</h2><p>Set up your role and build an evidence-led shortlist.</p></div></div>
          <Button type="button" className="back-link" onClick={() => setView(activeJobId ? 'jobs' : 'dashboard')}>
            ← Back
          </Button>
          <JobSetup job={job} setJob={setJob} files={files} setFiles={setFiles}
            onScreen={startScreening} error={error} roles={roles} setRoles={setRoles} />
        </>
      )}

      {view === 'express' && express && (
        <ExpressResults express={express} onBack={() => { setExpress(null); setView('setup'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      )}

      {view === 'screening' && (
        <NlpStudio total={total} doneCount={doneCount} currentFile={currentFile}
          resumes={pipes} candidates={candidates} ranking={ranking} job={job}
          error={screenError} startedAt={screeningStartedAt} batchComplete={batchComplete}
          onViewRanking={() => { setView('ranking'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      )}

      {view === 'ranking' && (
        <RankingView job={job} ranking={ranking} candidates={candidates} statuses={statuses}
          onSelectCandidate={setSelectedId} onStatusChange={handleStatusChange} onRestart={restart}
          sessionId={sessionId} onExport={handleExport} />
      )}

      {isHistoryDetail && historyDetail && (
        <RankingView
          job={{ title: historyDetail.job_title, company: historyDetail.job_company }}
          ranking={historyDetail.ranking || []}
          candidates={historyDetail.candidates || {}}
          statuses={statuses}
          onSelectCandidate={setSelectedId}
          onStatusChange={handleStatusChange}
          onRestart={restart}
          sessionId={historyDetail.id}
          readOnly
          onExport={handleExport}
          onBack={() => { setView('history'); setHistoryDetail(null); }}
        />
      )}

      {selected && (
        <CandidateDetail
          candidate={selected}
          statusInfo={selectedStatus}
          onClose={() => setSelectedId(null)}
          onStatus={isHistoryDetail ? null : handleStatusChange}
          readOnly={isHistoryDetail}
        />
      )}

      </main>
      <footer className="footer"><ShieldCheck size={16} />
        <p>Screening scores are similarity assessments to assist your decision — never hiring decisions. Names, colleges and contact details are never used in scoring, and no candidate is ever rejected automatically.</p>
      </footer>
    </div>
    </div>
  );
}
