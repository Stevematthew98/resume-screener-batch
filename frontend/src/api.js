// API base URL: VITE_API_URL in production (set on Vercel), localhost only
// as a local-development fallback. Never throw at module load — a missing
// base URL must not blank the whole app; it fails only when an API call is
// actually attempted.
const API_URL = (import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? 'http://localhost:8000' : '')).replace(/\/$/, '');

function requireApiUrl() {
  if (!API_URL) throw new Error('VITE_API_URL is not configured for this build.');
  return API_URL;
}

export const STAGE_ORDER = [
  'step1_ingest',
  'step2_extraction',
  'step3_preprocessing',
  'step4_vectors',
  'step5_matching',
  'step6_transparency',
  'step7_result',
  'step8_feedback',
];

export const STAGE_LABELS = {
  step1_ingest: 'Receiving your file',
  step2_extraction: 'Reading the text',
  step3_preprocessing: 'Finding your skills',
  step4_vectors: 'Comparing with the job',
  step5_matching: 'Scoring the match',
  step6_transparency: 'Explaining the score',
  step7_result: 'Preparing your report',
  step8_feedback: 'Ready for your feedback',
};

export function blankStages() {
  return STAGE_ORDER.map((key) => ({ key, label: STAGE_LABELS[key], status: 'pending', summary: '', detail: null }));
}

// ----------------------------------------------------------------------------
// Auth token + authed fetch
// ----------------------------------------------------------------------------

const TOKEN_KEY = 'rs_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export async function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const tok = getToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  const res = await fetch(`${requireApiUrl()}${path}`, { ...opts, headers });
  if (res.status === 401) {
    setToken(null);
    const err = new Error('SESSION_EXPIRED');
    err.sessionExpired = true;
    throw err;
  }
  return res;
}

export async function apiJson(path, opts = {}) {
  const res = await apiFetch(path, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Request failed. Please try again.');
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------

export async function signup(email, password, name) {
  const data = await apiJson('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
  });
  setToken(data.access_token);
  return data;
}

export async function login(email, password) {
  const data = await apiJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  setToken(data.access_token);
  return data;
}

export function logout() {
  setToken(null);
}

export async function getMe() {
  return apiJson('/api/auth/me');
}

export async function getDemoCreds() {
  const res = await fetch(`${requireApiUrl()}/api/auth/demo`);
  if (!res.ok) return null;
  return res.json();
}

// ----------------------------------------------------------------------------
// Jobs
// ----------------------------------------------------------------------------

export const listJobs = () => apiJson('/api/jobs');

export function createJob(job) {
  return apiJson('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
}

export function deleteJob(id) {
  return apiJson(`/api/jobs/${id}`, { method: 'DELETE' });
}

// ----------------------------------------------------------------------------
// Dashboard / history
// ----------------------------------------------------------------------------

export const getDashboard = () => apiJson('/api/dashboard');
export const listSessions = () => apiJson('/api/sessions');
export const getSessionDetail = (id) => apiJson(`/api/sessions/${id}`);

export async function downloadExport(sessionId, kind) {
  // kind: 'csv' | 'xlsx' | 'pdf'
  const suffix = kind === 'pdf' ? 'report.pdf' : kind === 'xlsx' ? 'export.xlsx' : 'export.csv';
  const res = await apiFetch(`/api/sessions/${sessionId}/${suffix}`);
  if (!res.ok) throw new Error('Export failed. Please try again.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `screening-session-${sessionId}.${kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ----------------------------------------------------------------------------
// Screening stream (SSE over fetch; carries the auth token + optional job_id)
// ----------------------------------------------------------------------------

/**
 * POST /api/screen/stream and parse the SSE event stream.
 * onEvent(evt) is called for every event. Resolves with the batch_complete event.
 */
export async function streamScreen(files, job, onEvent, opts = {}) {
  const form = new FormData();
  files.forEach((f) => form.append('resumes', f));
  form.append('job', JSON.stringify(job));
  if (opts.jobId) form.append('job_id', String(opts.jobId));
  const headers = {};
  const tok = getToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  let res;
  try {
    res = await fetch(`${requireApiUrl()}/api/screen/stream`, { method: 'POST', headers, body: form });
  } catch {
    throw new Error('Could not reach the screening service. Please check your connection and try again.');
  }
  if (res.status === 401) {
    setToken(null);
    const err = new Error('SESSION_EXPIRED');
    err.sessionExpired = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Screening failed to start. Please try again.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    finished = done;
    buf += decoder.decode(value || new Uint8Array(), { stream: !finished });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith('data:')) continue;
      let evt;
      try {
        evt = JSON.parse(chunk.slice(5).trim());
      } catch {
        continue;
      }
      onEvent(evt);
      if (evt.type === 'batch_complete') return evt;
    }
  }
  throw new Error('The screening stream ended unexpectedly. Please try again.');
}

/**
 * POST /api/screen/express — rapid dataset scan against multiple job roles.
 * Streams SSE: express_start → express_done (or express_error).
 * Resolves with the express_done event.
 */
export async function screenExpress(file, roles, onEvent) {
  const form = new FormData();
  form.append('dataset', file);
  form.append('roles', JSON.stringify(roles));
  const headers = {};
  const tok = getToken();
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  let res;
  try {
    res = await fetch(`${requireApiUrl()}/api/screen/express`, { method: 'POST', headers, body: form });
  } catch {
    throw new Error('Could not reach the screening service. Please check your connection and try again.');
  }
  if (res.status === 401) {
    setToken(null);
    const err = new Error('SESSION_EXPIRED');
    err.sessionExpired = true;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || 'Express scan failed to start. Please try again.');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  while (!finished) {
    const { value, done } = await reader.read();
    finished = done;
    buf += decoder.decode(value || new Uint8Array(), { stream: !finished });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (!chunk.startsWith('data:')) continue;
      let evt;
      try {
        evt = JSON.parse(chunk.slice(5).trim());
      } catch {
        continue;
      }
      onEvent(evt);
      if (evt.type === 'express_done') return evt;
      if (evt.type === 'express_error') throw new Error(evt.message || 'Express scan failed.');
    }
  }
  throw new Error('The express stream ended unexpectedly. Please try again.');
}

export async function setCandidateStatus(resume_id, status, notes = '', reject_reason = '') {
  return apiJson('/api/candidates/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resume_id, status, notes, reject_reason }),
  });
}

export async function getCandidateStatuses(sessionId) {
  const q = sessionId ? `?session_id=${sessionId}` : '';
  try {
    return await apiJson(`/api/candidates/statuses${q}`);
  } catch {
    return {};
  }
}

export async function sendFeedback(analysis_id, helpful, resume_id = null) {
  const res = await apiFetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis_id, verdict: helpful ? 'good_fit' : 'bad_fit', resume_id }),
  });
  if (!res.ok) throw new Error('Could not save feedback.');
  return res.json();
}

export async function getSkillGaps(sessionId) {
  return apiJson(`/api/sessions/${sessionId}/skill-gaps`);
}

export async function getRankerStatus() {
  try {
    return await apiJson('/api/ranker/status');
  } catch {
    return { active: false, decisions: 0, note: '' };
  }
}

export const API_BASE = API_URL;
