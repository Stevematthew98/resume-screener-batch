# Resume Screener Batch — multi-resume NLP screening (Phase 2)

Upload a batch of resumes (PDF/DOCX, or a `.zip` dataset) and a job description;
the backend runs its 8-step NLP pipeline over every file and returns ranked,
explainable fit assessments. Scoring is identical to the individual screener —
this project differs only in batch-first UX: one guided studio walk per batch
and client-side zip dataset extraction.

Monorepo:

- `backend/` — Python FastAPI (`app/main.py`, `app/pipeline.py`)
- `frontend/` — Vite + React single-page app

## The 8 steps (as implemented)

1. **Ingest** — file metadata (name, type, size), JD length.
2. **Extraction** — PyMuPDF for PDFs (pdfplumber fallback), python-docx for Word;
   text split into summary / experience / skills / education via heading regex.
3. **Preprocessing** — spaCy `en_core_web_sm` tokenize + lemmatize; skill extraction
   with a `PhraseMatcher` over `backend/data/skills.json` (~200-skill taxonomy with
   aliases, e.g. `ML` → `machine learning`); experience years from date ranges;
   degrees and job titles via regex/heuristics. PII (emails, phones) redacted.
4. **Vectors** — scikit-learn TF-IDF cosine (resume vs JD) plus
   `sentence-transformers/all-MiniLM-L6-v2` embedding cosine per section
   (full text, skills, experience) vs the JD.
5. **Matching / scoring** — hard filter on minimum experience.
   Single mode (`/api/analyze`): weighted score
   `0.35·emb_full + 0.25·emb_skills + 0.15·emb_experience + 0.15·skill_overlap + 0.10·tfidf`.
   Recruiter batch mode (`/api/screen/stream`): explainable fixed weights
   `0.50·skills_match + 0.25·jd_similarity + 0.15·experience + 0.10·education`,
   each component shown with its point contribution.
   Bands: ≥0.65 Strong match · 0.40–0.65 Worth reviewing · <0.40 Weak match.
   Matched vs missing JD skills listed.
6. **Transparency** — full score breakdown, method note, fairness note
   (names/colleges never used in scoring), limitations.
7. **Output** — final result object with band, score, facts.
8. **Feedback hook** — `analysis_id` returned for `POST /api/feedback`.

Bands are assessments, not guarantees — the final decision always belongs to a human.

## API

- `GET /api/health` → `{"status": "ok"}`
- `POST /api/analyze` (multipart): `resume` (PDF/DOCX, ≤10 MB),
  `job_description` (text), `min_experience_years` (float, optional, default 0)
- `POST /api/feedback`: `{"analysis_id": "...", "verdict": "good_fit"|"bad_fit"}`
- `GET /api/feedback/stats` → counts of recorded verdicts

## Run locally

Backend (Python 3.10+):

```bash
cd backend
pip install -r requirements.txt
python -m spacy download en_core_web_sm
python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"
uvicorn app.main:app --reload --port 8000
```

Frontend:

```bash
cd frontend
npm install
VITE_API_URL=http://localhost:8000 npm run dev
```

## Deploy

- **Backend → Railway** from `backend/`: Railpack build pre-downloads the spaCy and
  sentence-transformer models into the image (`railpack.json` sets the start command
  `uvicorn app.main:app --host 0.0.0.0 --port $PORT` and the model pre-download step).
- **Frontend → Vercel** from `frontend/` (root directory = `frontend`);
  set `VITE_API_URL` to the live Railway URL in production env.

## Batch screening (recruiter flow)

- `POST /api/screen/stream` (multipart, SSE `text/event-stream`): `resumes` (1–20
  PDF/DOCX files), `job` (JSON: `title`, `company`, `jd_text`, `required_skills`,
  `preferred_skills`, `min_experience_years`, `education_requirements`).
  Streams `job_ready` → per-resume `resume_start` → 8 `stage` events (same NLP
  pipeline, plain-language labels + one-line summaries from real outputs) →
  `resume_done` (full candidate profile) → `batch_complete` (ranking).
- Candidate scoring (fixed, explainable weights):
  `0.50·skills_match + 0.25·jd_similarity + 0.15·experience + 0.10·education`.
  Every component is shown with its point contribution and a grounded,
  evidence-only explanation.
- `POST /api/candidates/status`: `{"resume_id","status","notes","reject_reason"}` —
  statuses: New, Screened, Shortlisted, Under Review, Rejected. **Human-only**:
  scoring never changes a status; a low score can never auto-reject.
- `GET /api/candidates/statuses` → all known candidate statuses.
- Bias rules: names, colleges, contact details and other identity markers are
  never scoring inputs; personal info (name/email/phone) is extracted only for
  display in candidate profiles. Files are processed in memory and never stored.

## Known limitations

- Skill taxonomy is demo-grade (~200 entries); niche domains need a bigger list.
- Experience parsing is regex-based and approximate.
- The learned ranker is a simple per-skill lift model, not a trained ML ranker —
  it is honest about needing ≥5 mixed decisions before it activates.

## Phase 2 — shipped

- **Demo auth**: signup / login / logout with JWT sessions. Demo account
  `demo@recruiter.com` / `demo1234` is seeded on startup and shown on the login page.
  Clearly labelled as demo auth — not for real accounts.
- **Persistent database**: Railway Postgres plugin (SQLAlchemy models:
  users, jobs, screening_sessions, candidates, status_history, feedbacks).
  `DATABASE_URL` is wired from the Postgres service; tables auto-create on startup.
  All in-memory stores are gone — statuses, notes, jobs, sessions and feedback
  survive backend redeploys (verified).
- **Recruiter dashboard** (post-login landing): stat cards (resumes uploaded,
  candidates processed, shortlisted, average match score), recent sessions,
  score-distribution bar chart, "Start new screening" button.
- **Saved job profiles**: create / list / delete; "Screen candidates" against any
  saved job. Ad-hoc screenings auto-save their job so every run is linked.
- **Screening history**: every batch saved with its ranking snapshot, re-viewable
  read-only with exports.
- **Exports**: per-session CSV, Excel (openpyxl) and PDF screening report (ReportLab)
  — job title, date, ranking table, matched/missing skills per candidate.
- The NLP pipeline is untouched: extraction → spaCy preprocessing → skill NER →
  TF-IDF + MiniLM embeddings → weighted scoring (skills 50 / similarity 25 /
  experience 15 / education 10) → evidence-only explanations, with the live
  8-stage SSE timeline per resume during every screening run.
- Bias rules kept: names, colleges and contact details never enter scoring;
  every candidate starts "Screened"; scoring never auto-rejects; fairness note
  stays visible in the UI and the PDF report.

## Roadmap (deferred)

- Funnel-by-status charts
- Multi-user recruiter teams / roles

## Phase 3 — shipped

- **OCR for scanned PDFs**: PDFs whose extractable text is below a character
  threshold are treated as scanned — pages are rendered to images and OCR'd
  with Tesseract (`pytesseract`). The streaming timeline labels these honestly:
  "Scanned document — text recovered with OCR (may contain errors)".
  Deploy note: the backend now ships as a **Dockerfile** (Railway auto-detects
  it) because Railpack cannot install the `tesseract-ocr` apt package.
  `backend/railpack.json` was removed; the Dockerfile keeps the same behaviour
  (model pre-downloads at build, HF caches, uvicorn on `$PORT`).
- **Skill-gap analytics**: `GET /api/sessions/{id}/skill-gaps` and
  `GET /api/jobs/{id}/skill-gaps` return the most-common missing required
  skills with counts (`{skill, missing_count, total_candidates}`), aggregated
  live from persisted candidates. The ranking/history view renders them as a
  bar chart ("What this batch is missing").
- **Learned ranker from feedback**: personalizes the skills-match component
  from the recruiter's own recorded decisions (Shortlisted = positive,
  Rejected = negative, plus linked helpful/not-helpful votes). Per-skill
  *shortlist lift* = P(shortlisted | has skill) / P(shortlisted | lacks skill);
  skills with lift ≥ 1.2 get a modest importance boost (capped). Requires ≥5
  decisions with a mix of outcomes before activating — otherwise default
  scoring is used and `GET /api/ranker/status` says so. Every influence is
  disclosed in the candidate detail ("Adjusted because you shortlisted 3 of 4
  candidates with Kubernetes"). The 50/25/15/10 structure stays explainable;
  statuses are still human-only and scoring can never auto-reject.
  Candidate detail also has 👍/👎 "Was this analysis helpful?" votes, linked
  to the candidate for the ranker.
