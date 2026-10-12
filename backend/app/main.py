"""Resume Screener backend — FastAPI service.

Phase 2: demo auth (JWT), persistent database (Railway Postgres, SQLite
fallback), recruiter dashboard, saved job profiles, screening history,
CSV/Excel/PDF exports. The NLP pipeline itself (pipeline.py / screening.py)
is untouched — Phase 2 wraps it with persistence and management.
"""

import csv
import io
import json
import os
import re
import uuid
from typing import Any, Optional

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from .auth import (
    DEMO_EMAIL,
    DEMO_PASSWORD,
    create_token,
    get_current_user,
    get_optional_user,
    hash_password,
    seed_demo_user,
    user_public,
    verify_password,
)
from .db import (
    Candidate,
    Feedback,
    Job,
    ScreeningSession,
    StatusHistory,
    User,
    candidate_public,
    candidate_row,
    get_session,
    init_db,
    session_to_dict,
)
from .exports import build_csv, build_pdf, build_xlsx
from .pipeline import STAGE_ORDER, analyze_resume, ensure_models
from .ranker import get_personalization
from .screening import normalize_job, ranking_row, screen_one_resume

app = FastAPI(title="Resume Screener API", version="2.0.0")

_frontend = os.getenv("FRONTEND_URL", "*")
_origins = [o.strip() for o in _frontend.split(",") if o.strip()] if _frontend != "*" else ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CANDIDATE_STATUSES = ("New", "Screened", "Shortlisted", "Under Review", "Rejected")


class FeedbackIn(BaseModel):
    analysis_id: str
    verdict: str  # "good_fit" | "bad_fit"
    resume_id: Optional[str] = None  # links the vote to a screened candidate


class CandidateStatusIn(BaseModel):
    resume_id: str
    status: str  # one of CANDIDATE_STATUSES — set by humans only, never by scoring
    notes: str = ""
    reject_reason: str = ""


class SignupIn(BaseModel):
    email: str
    password: str
    name: str = ""


class LoginIn(BaseModel):
    email: str
    password: str


class JobIn(BaseModel):
    title: str
    company: str = ""
    jd_text: str = ""
    required_skills: Any = ""
    preferred_skills: Any = ""
    min_experience_years: float = 0.0
    education_requirements: str = ""


@app.on_event("startup")
def _startup():
    # Fail closed: never boot production with the insecure dev JWT fallback.
    if os.getenv("RAILWAY_ENVIRONMENT") == "production" and not os.getenv("JWT_SECRET", "").strip():
        raise RuntimeError("JWT_SECRET must be set in production.")
    # Models are pre-downloaded into the image at build time; this just loads them.
    ensure_models()
    init_db()
    seed_demo_user()


@app.get("/api/health")
def health():
    return {"status": "ok"}


# ----------------------------------------------------------------------------
# Demo auth
# ----------------------------------------------------------------------------

@app.post("/api/auth/signup")
def signup(item: SignupIn):
    email = (item.email or "").strip().lower()
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if len(item.password or "") < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    db = get_session()
    try:
        if db.query(User).filter(User.email == email).first():
            raise HTTPException(status_code=400, detail="An account with this email already exists.")
        user = User(email=email, name=(item.name or "").strip() or email.split("@")[0],
                    password_hash=hash_password(item.password))
        db.add(user)
        db.commit()
        db.refresh(user)
        return {"user": user_public(user), "access_token": create_token(user.id),
                "token_type": "bearer"}
    finally:
        db.close()


@app.post("/api/auth/login")
def login(item: LoginIn):
    email = (item.email or "").strip().lower()
    db = get_session()
    try:
        user = db.query(User).filter(User.email == email).first()
    finally:
        db.close()
    if user is None or not verify_password(item.password or "", user.password_hash):
        raise HTTPException(status_code=401, detail="Incorrect email or password.")
    return {"user": user_public(user), "access_token": create_token(user.id),
            "token_type": "bearer"}


@app.get("/api/auth/me")
def me(user: User = Depends(get_current_user)):
    return user_public(user)


@app.get("/api/auth/demo")
def demo_info():
    """Demo credentials shown on the login page."""
    return {"email": DEMO_EMAIL, "password": DEMO_PASSWORD,
            "note": "Demo auth for trying the product — not for real accounts."}


# ----------------------------------------------------------------------------
# Legacy single-resume analysis (unchanged public endpoint)
# ----------------------------------------------------------------------------

@app.post("/api/analyze")
async def analyze(
    resume: UploadFile = File(...),
    job_description: str = Form(""),
    min_experience_years: float = Form(0.0),
):
    filename = resume.filename or "resume"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ("pdf", "docx", "doc"):
        raise HTTPException(status_code=400, detail="Only PDF and DOCX resumes are supported.")
    data = await resume.read()
    if not data:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB).")
    # Resume bytes are processed in memory and never logged or persisted.
    result = analyze_resume(data, filename, job_description, min_experience_years)
    if result.get("processing_error"):
        # A file we cannot read is a processing failure, not a weak match.
        raise HTTPException(status_code=422, detail=result["processing_error"])
    return result


@app.post("/api/feedback")
def feedback(item: FeedbackIn, user: Optional[User] = Depends(get_optional_user)):
    if item.verdict not in ("good_fit", "bad_fit"):
        raise HTTPException(status_code=400, detail="verdict must be 'good_fit' or 'bad_fit'.")
    db = get_session()
    try:
        candidate_id = None
        if item.resume_id and user is not None:
            # Link the vote to the candidate only when we can verify ownership.
            cand = (db.query(Candidate).join(ScreeningSession)
                      .filter(Candidate.resume_id == item.resume_id,
                              ScreeningSession.user_id == user.id).first())
            if cand is not None:
                candidate_id = cand.id
        db.add(Feedback(analysis_id=item.analysis_id, verdict=item.verdict,
                        user_id=user.id if user else None, candidate_id=candidate_id))
        db.commit()
        count = db.query(Feedback).filter(Feedback.analysis_id == item.analysis_id).count()
    finally:
        db.close()
    return {"analysis_id": item.analysis_id, "verdicts_recorded": count,
            "linked_candidate": candidate_id is not None}


@app.get("/api/feedback/stats")
def feedback_stats():
    db = get_session()
    try:
        total = db.query(Feedback).count()
        analyses = db.query(Feedback.analysis_id).distinct().count()
    finally:
        db.close()
    return {"analyses_with_feedback": analyses, "total_verdicts": total}


# ----------------------------------------------------------------------------
# Job profiles
# ----------------------------------------------------------------------------

def _job_public(job: Job, sessions_count: int = 0) -> dict:
    return {
        "id": job.id,
        "title": job.title,
        "company": job.company,
        "jd_text": job.jd_text,
        "required_skills": job.required_skills or [],
        "preferred_skills": job.preferred_skills or [],
        "min_experience_years": job.min_experience_years,
        "education_requirements": job.education_requirements,
        "created_at": job.created_at.isoformat() if job.created_at else "",
        "sessions_count": sessions_count,
    }


@app.post("/api/jobs")
def create_job(item: JobIn, user: User = Depends(get_current_user)):
    if not (item.title or "").strip():
        raise HTTPException(status_code=400, detail="Job title is required.")
    norm = normalize_job(item.dict())
    db = get_session()
    try:
        job = Job(user_id=user.id, **norm)
        db.add(job)
        db.commit()
        db.refresh(job)
        return _job_public(job)
    finally:
        db.close()


@app.get("/api/jobs")
def list_jobs(user: User = Depends(get_current_user)):
    db = get_session()
    try:
        jobs = db.query(Job).filter(Job.user_id == user.id).order_by(Job.created_at.desc()).all()
        out = []
        for j in jobs:
            n = db.query(ScreeningSession).filter(
                ScreeningSession.job_id == j.id, ScreeningSession.user_id == user.id).count()
            out.append(_job_public(j, n))
        return out
    finally:
        db.close()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == user.id).first()
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return _job_public(job)
    finally:
        db.close()


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == user.id).first()
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        db.delete(job)
        db.commit()
        return {"deleted": job_id}
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Batch screening with live NLP pipeline streaming + persistence
# ----------------------------------------------------------------------------

MAX_BATCH_FILES = 20
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_CSV_BYTES = 50 * 1024 * 1024  # datasets are bigger than single resumes
ALLOWED_EXTS = ("pdf", "docx", "doc", "csv")


def _check_upload(filename: str, data: bytes) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ext not in ALLOWED_EXTS:
        raise HTTPException(status_code=400,
                            detail=f"'{filename}': only PDF, DOCX, and CSV resumes are supported.")
    if not data:
        raise HTTPException(status_code=400, detail=f"'{filename}' is empty.")
    limit = MAX_CSV_BYTES if ext == "csv" else MAX_FILE_BYTES
    if len(data) > limit:
        raise HTTPException(status_code=400,
                            detail=f"'{filename}' exceeds {limit // (1024 * 1024)} MB.")
    return ext


def _sse(obj: dict) -> str:
    return "data: " + json.dumps(obj, default=str) + "\n\n"


# ----------------------------------------------------------------------------
# CSV resume datasets (e.g. Kaggle) — one row == one resume
# ----------------------------------------------------------------------------

CSV_TEXT_HINTS = ("resume", "resume_str", "resume_text", "cv", "profile", "text",
                  "content", "description", "summary", "details", "bio",
                  "feature")  # "Feature" holds the resume text in the popular Kaggle dataset
CSV_CATEGORY_HINTS = ("category", "label", "job_category", "class", "target",
                      "domain", "profession")
CSV_NAME_HINTS = ("name", "candidate", "candidate_name", "applicant", "full_name",
                  "fullname", "person")
CSV_ID_HINTS = ("id", "index", "sno", "sr", "serial", "row", "slno")


def _norm_col(c: str) -> str:
    return "".join(ch for ch in (c or "").lower() if ch.isalnum())


def _find_col(columns, hints):
    for hint in hints:
        for c in columns:
            if hint in _norm_col(c):
                return c
    return None


def _parse_csv_dataset(filename: str, data: bytes, cap: int = MAX_BATCH_FILES):
    """Parse an uploaded CSV resume dataset (e.g. from Kaggle).

    Returns (rows, info): rows = [(display_name, resume_text, name, ext_id,
    category), ...] capped at `cap`; info describes column detection +
    truncation for honesty. Raises HTTPException(400) when unusable.
    """
    text = None
    for enc in ("utf-8-sig", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except (UnicodeDecodeError, ValueError):
            continue
    if not text or not text.strip():
        raise HTTPException(status_code=400, detail=f"'{filename}' is empty.")
    try:
        dialect = csv.Sniffer().sniff(text[:65536], delimiters=[",", ";", "\t", "|"])
    except Exception:
        dialect = csv.excel
    try:
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        columns = reader.fieldnames
        rows_raw = [r for r in reader if r]
    except Exception:
        columns, rows_raw = None, []
    if not columns:
        raise HTTPException(
            status_code=400,
            detail=f"'{filename}': could not read a header row — is this a valid CSV?")
    if not rows_raw:
        raise HTTPException(status_code=400,
                            detail=f"'{filename}' has no data rows.")
    text_col = _find_col(columns, CSV_TEXT_HINTS)
    if not text_col:
        # Fallback: the non-id column with the longest average content.
        best, best_avg = None, -1.0
        for c in columns:
            if _norm_col(c) in CSV_ID_HINTS:
                continue
            vals = [(r.get(c) or "") for r in rows_raw]
            avg = sum(len(v) for v in vals) / max(len(vals), 1)
            if avg > best_avg:
                best, best_avg = c, avg
        text_col = best
    cat_col = _find_col(columns, CSV_CATEGORY_HINTS)
    name_col = _find_col(columns, CSV_NAME_HINTS)
    id_col = next((c for c in columns if _norm_col(c) in ("id", "resumeid", "resume_id")), None)
    if not text_col or not any((r.get(text_col) or "").strip() for r in rows_raw):
        shown = ", ".join(columns[:8])
        raise HTTPException(
            status_code=400,
            detail=f"'{filename}': no resume text found — looked for a resume/text "
                   f"column among: {shown}.")
    avg_len = sum(len(r.get(text_col) or "") for r in rows_raw) / max(len(rows_raw), 1)
    if avg_len < 50:
        shown = ", ".join(columns[:8])
        raise HTTPException(
            status_code=400,
            detail=f"'{filename}': the '{text_col}' column averages "
                   f"{avg_len:.0f} characters — not resume text (columns: {shown}).")
    total_rows = len(rows_raw)
    out, skipped = [], 0
    for i, r in enumerate(rows_raw, start=1):
        t = (r.get(text_col) or "").strip()
        if not t:
            skipped += 1
            continue
        name = (r.get(name_col) or "").strip() if name_col else ""
        cat = (r.get(cat_col) or "").strip() if cat_col else ""
        ext_id = (r.get(id_col) or "").strip() if id_col else ""
        label = name or (f"{cat} · Row {i}" if cat else f"Row {i}")
        label = re.sub(r"[\\/:*?\"<>|]", " ", label).strip()[:60] or f"Row {i}"
        out.append((f"{label}.csv", t, name or None, ext_id or None, cat or None))
        if len(out) >= cap:
            break
    if not out:
        raise HTTPException(status_code=400,
                            detail=f"'{filename}': the resume-text column is empty.")
    info = {
        "total_rows": total_rows,
        "used_rows": len(out),
        "skipped_empty": skipped,
        "truncated": len(out) < (total_rows - skipped),
        "text_column": text_col,
        "category_column": cat_col,
        "name_column": name_col,
    }
    return out, info


def _persist_candidate(db, session_id: int, resume_id: str, filename: str, payload: dict) -> None:
    personal = payload.get("personal", {}) or {}
    skills_comp = (payload.get("components", {}) or {}).get("skills", {}) or {}
    cand = Candidate(
        session_id=session_id,
        resume_id=resume_id,
        filename=filename,
        name=personal.get("name", "") or "",
        email=personal.get("email", "") or "",
        phone=personal.get("phone", "") or "",
        score=payload.get("score", 0.0),
        band=payload.get("band", ""),
        experience_years=payload.get("experience_years", 0.0),
        degrees=payload.get("degrees", []),
        job_titles=payload.get("job_titles", []),
        matched_skills=payload.get("matched_skills", []),
        missing_skills=payload.get("missing_skills", []),
        preferred_matched=skills_comp.get("preferred_matched", []),
        components=payload.get("components", {}),
        explanation=payload.get("explanation", []),
        sections=payload.get("sections", {}),
        meets_experience_requirement=payload.get("meets_experience_requirement", False),
        fairness_note=payload.get("fairness_note", ""),
        profile_json=payload,
        status="Screened",  # every candidate starts Screened; scoring never auto-rejects
        notes="",
        reject_reason="",
    )
    db.add(cand)
    db.flush()
    db.add(StatusHistory(candidate_id=cand.id, old_status="", new_status="Screened"))
    db.commit()


@app.post("/api/screen/stream")
async def screen_stream(
    resumes: list[UploadFile] = File(...),
    job: str = Form(...),
    job_id: Optional[str] = Form(None),
    user: User = Depends(get_current_user),
):
    """Screen a batch of resumes with live per-resume NLP stage events (SSE).

    Form fields: resumes (1..20 files — PDF, DOCX, or CSV datasets where one
    row == one resume), job (JSON job spec), job_id (optional, links this run
    to a saved job profile). Requires auth.
    Event types: job_ready, resume_start, stage, resume_done, resume_error,
    batch_complete.
    """
    try:
        job_spec = normalize_job(json.loads(job))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid job JSON.")
    if not job_spec["jd_text"]:
        raise HTTPException(status_code=400, detail="Job description text is required.")
    if not resumes:
        raise HTTPException(status_code=400, detail="Upload at least one resume.")

    # Read uploads; expand CSV datasets (one row == one resume) into
    # individual items. items = (filename, data, pre_extracted_text, candidate_name).
    items: list[tuple[str, bytes, Optional[str], Optional[str]]] = []
    csv_notes: list[str] = []
    for up in resumes:
        filename = up.filename or "resume"
        data = await up.read()
        ext = _check_upload(filename, data)
        if ext == "csv":
            rows, info = _parse_csv_dataset(filename, data)
            for disp_name, text, name, _ext_id, _cat in rows:
                items.append((disp_name, b"", text, name))
            if info["truncated"]:
                csv_notes.append(
                    f"'{filename}': {info['total_rows']} rows — "
                    f"screening the first {info['used_rows']}.")
        else:
            items.append((filename, data, None, None))
    # Resume bytes are processed in memory and never logged or persisted.
    if not items:
        raise HTTPException(status_code=400, detail="No resumes to screen.")
    if len(items) > MAX_BATCH_FILES:
        raise HTTPException(status_code=400,
                            detail=f"Maximum {MAX_BATCH_FILES} resumes per batch.")

    db = get_session()
    linked_job_id = None
    if job_id:
        try:
            jid = int(job_id)
        except (TypeError, ValueError):
            jid = None
        if jid:
            exists = db.query(Job).filter(Job.id == jid, Job.user_id == user.id).first()
            if exists:
                linked_job_id = jid
    session = ScreeningSession(
        user_id=user.id,
        job_id=linked_job_id,
        job_title=job_spec["title"],
        job_company=job_spec["company"],
        job_snapshot=job_spec,
        total_resumes=len(items),
        screened_count=0,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    session_id = session.id
    # Learned ranker: computed once from this recruiter's recorded decisions
    # BEFORE the batch, so the batch itself can't influence its own scores.
    personalization = get_personalization(db, user.id)
    db.close()

    async def event_gen():
        total = len(items)
        yield _sse({"type": "job_ready", "total": total, "session_id": session_id,
                    "job": {"title": job_spec["title"], "company": job_spec["company"]},
                    "notes": csv_notes})
        ranking: list[dict] = []
        screened = 0
        for idx, (filename, data, pre_text, cand_name) in enumerate(items):
            resume_id = uuid.uuid4().hex
            yield _sse({"type": "resume_start", "resume_id": resume_id,
                        "filename": filename, "index": idx, "total": total})
            try:
                for kind, payload in screen_one_resume(data, filename, job_spec,
                                                       resume_id, personalization,
                                                       pre_extracted_text=pre_text,
                                                       candidate_name=cand_name):
                    if kind == "stage":
                        yield _sse({"type": "stage", "resume_id": resume_id,
                                    "filename": filename, "index": idx, "total": total,
                                    **payload})
                    elif kind == "error":
                        yield _sse({"type": "resume_error", "resume_id": resume_id,
                                    "filename": filename, "index": idx, "total": total,
                                    "message": payload.get("message") or
                                    "Could not analyse this file."})
                    else:
                        dbs = get_session()
                        try:
                            _persist_candidate(dbs, session_id, resume_id, filename, payload)
                        finally:
                            dbs.close()
                        row = ranking_row(payload)
                        row["status"] = "Screened"
                        ranking.append(row)
                        screened += 1
                        yield _sse({"type": "resume_done", "resume_id": resume_id,
                                    "filename": filename, "index": idx, "total": total,
                                    "candidate": payload})
            except Exception:  # one bad file must not kill the batch
                yield _sse({"type": "resume_error", "resume_id": resume_id,
                            "filename": filename, "index": idx, "total": total,
                            "message": "Could not analyse this file."})
        ranking.sort(key=lambda r: r["score"], reverse=True)
        for rank, row in enumerate(ranking, start=1):
            row["rank"] = rank
        dbs = get_session()
        try:
            s = dbs.query(ScreeningSession).filter(ScreeningSession.id == session_id).first()
            if s:
                s.screened_count = screened
                dbs.commit()
        finally:
            dbs.close()
        yield _sse({"type": "batch_complete", "total": total, "screened": screened,
                    "session_id": session_id, "ranking": ranking})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ----------------------------------------------------------------------------
# Express dataset mode — whole CSV scored against multiple roles in seconds
# ----------------------------------------------------------------------------

@app.post("/api/screen/express")
async def screen_express(
    dataset: UploadFile = File(...),
    roles: str = Form(...),
    user: User = Depends(get_current_user),
):
    """Rapid scan of a large CSV resume dataset against multiple job roles.

    Form fields: dataset (one CSV file), roles (JSON list of
    {title, required_skills:[str], min_experience_years}).
    Streams SSE: express_start → express_done (or express_error).
    Not persisted to history — a rapid scan, not a deep screening session.
    """
    from .express import EXPRESS_MAX_ROWS, run_express
    try:
        roles_in = json.loads(roles)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid roles JSON.")
    if not isinstance(roles_in, list) or not roles_in:
        raise HTTPException(status_code=400, detail="At least one job role is required.")
    if len(roles_in) > 8:
        raise HTTPException(status_code=400, detail="Maximum 8 job roles per scan.")
    clean_roles = []
    for r in roles_in:
        if not isinstance(r, dict):
            continue
        req = r.get("required_skills") or []
        if isinstance(req, str):
            req = [s.strip() for s in req.replace(";", ",").split(",") if s.strip()]
        req = [s for s in req if isinstance(s, str) and s.strip()][:40]
        title = (r.get("title") or "").strip()
        if not title or not req:
            continue
        try:
            min_exp = float(r.get("min_experience_years") or 0)
        except (TypeError, ValueError):
            min_exp = 0.0
        clean_roles.append({"title": title[:80], "required_skills": req,
                            "min_experience_years": max(0.0, min_exp)})
    if not clean_roles:
        raise HTTPException(status_code=400,
                            detail="Each role needs a title and at least one required skill.")

    filename = dataset.filename or "dataset.csv"
    data = await dataset.read()
    ext = _check_upload(filename, data)
    if ext != "csv":
        raise HTTPException(status_code=400,
                            detail="Express mode needs a CSV dataset file.")
    rows, info = _parse_csv_dataset(filename, data, cap=EXPRESS_MAX_ROWS)
    items = [{"ext_id": ext_id or f"row-{i}",
              "name": name or disp.replace(".csv", ""),
              "category": cat or "",
              "text": text}
             for i, (disp, text, name, ext_id, cat) in enumerate(rows, start=1)]

    async def event_gen():
        yield _sse({"type": "express_start", "total": len(items),
                    "roles": [r["title"] for r in clean_roles],
                    "truncated": info["truncated"], "total_rows": info["total_rows"]})
        try:
            import asyncio
            result = await asyncio.to_thread(
                run_express,
                [(it["ext_id"], it["name"], it["category"], it["text"]) for it in items],
                clean_roles,
            )
        except Exception as e:
            yield _sse({"type": "express_error",
                        "message": f"Express scan failed: {e}"})
            return
        result["dataset"] = {"filename": filename, "total_rows": info["total_rows"],
                             "scored_rows": len(items),
                             "truncated": info["truncated"],
                             "text_column": info["text_column"]}
        yield _sse({"type": "express_done", **result})

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

@app.post("/api/candidates/status")
def set_candidate_status(item: CandidateStatusIn, user: User = Depends(get_current_user)):
    """Human-only status change. A low score can never reject a candidate."""
    if item.status not in CANDIDATE_STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"status must be one of {CANDIDATE_STATUSES}.")
    db = get_session()
    try:
        cand = (db.query(Candidate).join(ScreeningSession)
                  .filter(Candidate.resume_id == item.resume_id,
                          ScreeningSession.user_id == user.id).first())
        if cand is None:
            raise HTTPException(status_code=404, detail="Unknown resume_id.")
        old = cand.status
        cand.status = item.status
        cand.notes = item.notes or ""
        cand.reject_reason = item.reject_reason if item.status == "Rejected" else ""
        db.add(StatusHistory(candidate_id=cand.id, old_status=old,
                             new_status=item.status, notes=cand.notes,
                             reject_reason=cand.reject_reason))
        db.commit()
        return {"resume_id": cand.resume_id, "status": cand.status, "notes": cand.notes,
                "reject_reason": cand.reject_reason, "filename": cand.filename}
    finally:
        db.close()


@app.get("/api/candidates/statuses")
def get_candidate_statuses(session_id: Optional[int] = None,
                           user: User = Depends(get_current_user)):
    db = get_session()
    try:
        q = (db.query(Candidate).join(ScreeningSession)
               .filter(ScreeningSession.user_id == user.id))
        if session_id:
            q = q.filter(Candidate.session_id == session_id)
        return {c.resume_id: {"status": c.status, "notes": c.notes,
                              "reject_reason": c.reject_reason, "filename": c.filename}
                for c in q.all()}
    finally:
        db.close()


@app.get("/api/candidates/{resume_id}")
def get_candidate(resume_id: str, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        cand = (db.query(Candidate).join(ScreeningSession)
                  .filter(Candidate.resume_id == resume_id,
                          ScreeningSession.user_id == user.id).first())
        if cand is None:
            raise HTTPException(status_code=404, detail="Candidate not found.")
        return candidate_public(cand)
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Dashboard
# ----------------------------------------------------------------------------

@app.get("/api/dashboard")
def dashboard(user: User = Depends(get_current_user)):
    db = get_session()
    try:
        sessions = (db.query(ScreeningSession)
                      .filter(ScreeningSession.user_id == user.id)
                      .order_by(ScreeningSession.created_at.desc()).all())
        candidates = (db.query(Candidate).join(ScreeningSession)
                        .filter(ScreeningSession.user_id == user.id).all())
        scores = [c.score for c in candidates]
        dist = {"Strong match": 0, "Worth reviewing": 0, "Weak match": 0}
        for c in candidates:
            if c.band in dist:
                dist[c.band] += 1
        return {
            "stats": {
                "total_resumes": sum(s.total_resumes for s in sessions),
                "candidates_processed": len(candidates),
                "shortlisted": sum(1 for c in candidates if c.status == "Shortlisted"),
                "avg_score": round(sum(scores) / len(scores), 4) if scores else 0.0,
            },
            "recent_sessions": [session_to_dict(s) for s in sessions[:8]],
            "score_distribution": [{"label": k, "count": v} for k, v in dist.items()],
        }
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Screening history
# ----------------------------------------------------------------------------

@app.get("/api/sessions")
def list_sessions(user: User = Depends(get_current_user)):
    db = get_session()
    try:
        sessions = (db.query(ScreeningSession)
                      .filter(ScreeningSession.user_id == user.id)
                      .order_by(ScreeningSession.created_at.desc()).all())
        return [session_to_dict(s) for s in sessions]
    finally:
        db.close()


@app.get("/api/sessions/{session_id}")
def get_session_detail(session_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        s = (db.query(ScreeningSession)
               .filter(ScreeningSession.id == session_id,
                       ScreeningSession.user_id == user.id).first())
        if s is None:
            raise HTTPException(status_code=404, detail="Session not found.")
        cands = sorted(s.candidates, key=lambda c: c.score, reverse=True)
        ranking = []
        for rank, c in enumerate(cands, start=1):
            row = candidate_row(c)
            row["rank"] = rank
            ranking.append(row)
        return {
            **session_to_dict(s),
            "job": s.job_snapshot or {},
            "ranking": ranking,
            "candidates": {c.resume_id: candidate_public(c) for c in cands},
        }
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Learned ranker status
# ----------------------------------------------------------------------------

@app.get("/api/ranker/status")
def ranker_status(user: User = Depends(get_current_user)):
    """How the learned ranker is behaving for this recruiter.

    Personalization activates after enough recorded decisions; until then
    default scoring is used and the response says so.
    """
    db = get_session()
    try:
        return get_personalization(db, user.id)
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Skill-gap analytics
# ----------------------------------------------------------------------------

def _skill_gap_aggregate(candidates) -> dict:
    """Most-common missing required skills across a set of candidates."""
    from collections import Counter
    counter: Counter = Counter()
    for c in candidates:
        for s in c.missing_skills or []:
            counter[s] += 1
    total = len(candidates)
    return {
        "total_candidates": total,
        "gaps": [
            {"skill": skill, "missing_count": count, "total_candidates": total}
            for skill, count in counter.most_common()
        ],
    }


@app.get("/api/sessions/{session_id}/skill-gaps")
def session_skill_gaps(session_id: int, user: User = Depends(get_current_user)):
    """Aggregate missing-skill counts for one screening session."""
    db = get_session()
    try:
        s = _owned_session(db, session_id, user)
        return {"session_id": session_id, **_skill_gap_aggregate(s.candidates or [])}
    finally:
        db.close()


@app.get("/api/jobs/{job_id}/skill-gaps")
def job_skill_gaps(job_id: int, user: User = Depends(get_current_user)):
    """Aggregate missing-skill counts across all sessions of a saved job."""
    db = get_session()
    try:
        job = db.query(Job).filter(Job.id == job_id, Job.user_id == user.id).first()
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        cands = (db.query(Candidate).join(ScreeningSession)
                   .filter(ScreeningSession.job_id == job_id,
                           ScreeningSession.user_id == user.id).all())
        return {"job_id": job_id, "job_title": job.title,
                **_skill_gap_aggregate(cands)}
    finally:
        db.close()


# ----------------------------------------------------------------------------
# Exports
# ----------------------------------------------------------------------------

def _owned_session(db, session_id: int, user: User) -> ScreeningSession:
    s = (db.query(ScreeningSession)
           .filter(ScreeningSession.id == session_id,
                   ScreeningSession.user_id == user.id).first())
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return s


@app.get("/api/sessions/{session_id}/export.csv")
def export_csv(session_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        s = _owned_session(db, session_id, user)
        cands = sorted(s.candidates, key=lambda c: c.score, reverse=True)
        data = build_csv(s, cands)
    finally:
        db.close()
    return Response(content=data, media_type="text/csv",
                    headers={"Content-Disposition":
                             f"attachment; filename=screening-session-{session_id}.csv"})


@app.get("/api/sessions/{session_id}/export.xlsx")
def export_xlsx(session_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        s = _owned_session(db, session_id, user)
        cands = sorted(s.candidates, key=lambda c: c.score, reverse=True)
        data = build_xlsx(s, cands)
    finally:
        db.close()
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition":
                 f"attachment; filename=screening-session-{session_id}.xlsx"})


@app.get("/api/sessions/{session_id}/report.pdf")
def export_pdf(session_id: int, user: User = Depends(get_current_user)):
    db = get_session()
    try:
        s = _owned_session(db, session_id, user)
        cands = sorted(s.candidates, key=lambda c: c.score, reverse=True)
        data = build_pdf(s, cands)
    finally:
        db.close()
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition":
                             f"attachment; filename=screening-report-{session_id}.pdf"})
