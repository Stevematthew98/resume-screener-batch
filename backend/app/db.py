"""Persistent database layer — SQLAlchemy models.

Uses Railway Postgres when DATABASE_URL is set, otherwise SQLite
(local dev or a persistent volume at /data). Tables are auto-created
on startup. All previous in-memory stores (statuses, feedback) are
replaced by these tables so data survives redeploys.
"""

import json
import os
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    create_engine,
    func,
)
from sqlalchemy.orm import declarative_base, relationship, sessionmaker

Base = declarative_base()


def get_db_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        # Railway Postgres plugin exposes postgresql:// — pin the psycopg2 driver
        # explicitly since SQLAlchemy 2.x otherwise looks for psycopg (v3).
        if url.startswith("postgresql://"):
            url = "postgresql+psycopg2://" + url[len("postgresql://"):]
        return url
    data_dir = "/data" if os.path.isdir("/data") else os.path.dirname(os.path.abspath(__file__))
    return f"sqlite:///{os.path.join(data_dir, 'resume_screener.db')}"


DB_URL = get_db_url()
_connect_args = {"check_same_thread": False} if DB_URL.startswith("sqlite") else {}
engine = create_engine(DB_URL, connect_args=_connect_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    name = Column(String(255), nullable=False, default="")
    password_hash = Column(String(512), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    jobs = relationship("Job", back_populates="user", cascade="all, delete-orphan")
    sessions = relationship("ScreeningSession", back_populates="user", cascade="all, delete-orphan")


class Job(Base):
    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    company = Column(String(255), nullable=False, default="")
    jd_text = Column(Text, nullable=False, default="")
    required_skills = Column(JSON, nullable=False, default=list)
    preferred_skills = Column(JSON, nullable=False, default=list)
    min_experience_years = Column(Float, nullable=False, default=0.0)
    education_requirements = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    user = relationship("User", back_populates="jobs")
    sessions = relationship("ScreeningSession", back_populates="job")


class ScreeningSession(Base):
    __tablename__ = "screening_sessions"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    job_id = Column(Integer, ForeignKey("jobs.id"), nullable=True, index=True)
    job_title = Column(String(255), nullable=False, default="")
    job_company = Column(String(255), nullable=False, default="")
    job_snapshot = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    total_resumes = Column(Integer, nullable=False, default=0)
    screened_count = Column(Integer, nullable=False, default=0)
    method = Column(String(32), nullable=False, default="deep", server_default="deep")
    # method: 'deep' (8-stage pipeline) or 'express' (rapid multi-role dataset scan)

    user = relationship("User", back_populates="sessions")
    job = relationship("Job", back_populates="sessions")
    candidates = relationship("Candidate", back_populates="session",
                              cascade="all, delete-orphan", order_by="Candidate.score.desc()")


class Candidate(Base):
    __tablename__ = "candidates"
    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("screening_sessions.id"), nullable=False, index=True)
    resume_id = Column(String(64), unique=True, nullable=False, index=True)  # public uuid
    filename = Column(String(512), nullable=False, default="")
    name = Column(String(255), nullable=False, default="")
    email = Column(String(255), nullable=False, default="")
    phone = Column(String(64), nullable=False, default="")
    score = Column(Float, nullable=False, default=0.0)
    band = Column(String(64), nullable=False, default="")
    experience_years = Column(Float, nullable=False, default=0.0)
    degrees = Column(JSON, nullable=False, default=list)
    job_titles = Column(JSON, nullable=False, default=list)
    matched_skills = Column(JSON, nullable=False, default=list)
    missing_skills = Column(JSON, nullable=False, default=list)
    preferred_matched = Column(JSON, nullable=False, default=list)
    components = Column(JSON, nullable=False, default=dict)
    explanation = Column(JSON, nullable=False, default=list)
    sections = Column(JSON, nullable=False, default=dict)
    meets_experience_requirement = Column(Boolean, nullable=False, default=False)
    fairness_note = Column(Text, nullable=False, default="")
    profile_json = Column(JSON, nullable=False, default=dict)  # full candidate payload
    status = Column(String(64), nullable=False, default="Screened", index=True)
    notes = Column(Text, nullable=False, default="")
    reject_reason = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    session = relationship("ScreeningSession", back_populates="candidates")
    history = relationship("StatusHistory", back_populates="candidate",
                           cascade="all, delete-orphan", order_by="StatusHistory.changed_at")


class StatusHistory(Base):
    __tablename__ = "status_history"
    id = Column(Integer, primary_key=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=False, index=True)
    old_status = Column(String(64), nullable=False, default="")
    new_status = Column(String(64), nullable=False, default="")
    notes = Column(Text, nullable=False, default="")
    reject_reason = Column(Text, nullable=False, default="")
    changed_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    candidate = relationship("Candidate", back_populates="history")


class Feedback(Base):
    __tablename__ = "feedbacks"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(String(128), nullable=False, index=True)
    verdict = Column(String(32), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    candidate_id = Column(Integer, ForeignKey("candidates.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ----------------------------------------------------------------------------
# Init + helpers
# ----------------------------------------------------------------------------

def _migrate() -> None:
    """Additive migrations for tables created by earlier releases.
    create_all() never alters existing tables, so new columns are added here.
    """
    from sqlalchemy import text
    with engine.begin() as conn:
        if DB_URL.startswith("sqlite"):
            cols = [r[1] for r in conn.execute(
                text("PRAGMA table_info(feedbacks)")).fetchall()]
            if "candidate_id" not in cols:
                conn.execute(text("ALTER TABLE feedbacks ADD COLUMN candidate_id INTEGER"))
        else:
            conn.execute(text(
                "ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS candidate_id INTEGER"))
        # screening_sessions.method (express dataset scans)
        if DB_URL.startswith("sqlite"):
            scols = [r[1] for r in conn.execute(
                text("PRAGMA table_info(screening_sessions)")).fetchall()]
            if "method" not in scols:
                conn.execute(text(
                    "ALTER TABLE screening_sessions ADD COLUMN method VARCHAR(32) NOT NULL DEFAULT 'deep'"))
        else:
            conn.execute(text(
                "ALTER TABLE screening_sessions ADD COLUMN IF NOT EXISTS method VARCHAR(32) NOT NULL DEFAULT 'deep'"))


def init_db() -> None:
    """Create tables if missing. Safe to call on every startup."""
    Base.metadata.create_all(engine)
    _migrate()


def get_session():
    return SessionLocal()


def session_to_dict(s: ScreeningSession) -> dict:
    cands = s.candidates or []
    scores = [c.score for c in cands]
    snap = s.job_snapshot or {}
    return {
        "id": s.id,
        "job_id": s.job_id,
        "job_title": s.job_title,
        "job_company": s.job_company,
        "created_at": s.created_at.isoformat() if s.created_at else "",
        "total_resumes": s.total_resumes,
        "screened_count": s.screened_count,
        "avg_score": round(sum(scores) / len(scores), 4) if scores else 0.0,
        "method": s.method or "deep",
        "roles": snap.get("roles") or [],
        "elapsed_seconds": snap.get("elapsed_seconds"),
    }


def candidate_public(c: Candidate) -> dict:
    """Full candidate payload for the frontend (detail view)."""
    profile = dict(c.profile_json or {})
    profile.update({
        "resume_id": c.resume_id,
        "status": c.status,
        "notes": c.notes,
        "reject_reason": c.reject_reason,
    })
    return profile


def candidate_row(c: Candidate) -> dict:
    return {
        "resume_id": c.resume_id,
        "filename": c.filename,
        "name": c.name,
        "score": c.score,
        "band": c.band,
        "matched_skills": c.matched_skills or [],
        "missing_skills": c.missing_skills or [],
        "experience_years": c.experience_years,
        "status": c.status,
        "notes": c.notes,
        "reject_reason": c.reject_reason,
    }
