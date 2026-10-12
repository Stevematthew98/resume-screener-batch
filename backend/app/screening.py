"""Batch screening for recruiters — runs the 8-stage NLP pipeline per resume and
assembles an explainable, bias-aware ranking.

Scoring formula (fixed weights, shown to the recruiter in plain language):
    score = 0.50 * skills_match + 0.25 * jd_similarity + 0.15 * experience + 0.10 * education

Bias rules (enforced, not just documented):
- Names, colleges/universities, emails, phones and other identity markers are
  NEVER inputs to scoring. Scoring uses only: extracted skills, semantic
  similarity of resume text to the job description, years of experience, and
  degree-keyword matches.
- No candidate is ever auto-rejected: every screened resume starts at status
  "Screened"; only a human can move it to Shortlisted / Under Review / Rejected.

Resume text is never logged. Uploaded files are processed in memory only.
"""

from datetime import datetime

from .pipeline import (
    STAGE_LABELS,
    STAGE_ORDER,
    run_pipeline_stages,
    stage_summary,
)
from .ranker import skill_weights

# ----------------------------------------------------------------------------
# Job spec normalization
# ----------------------------------------------------------------------------

_DETECTION_NOTE = ("Skills listed as not detected were not found in the resume text. "
                   "'Not detected' is not proof the candidate lacks the skill.")

DEFAULT_JOB = {
    "title": "",
    "company": "",
    "jd_text": "",
    "required_skills": [],
    "preferred_skills": [],
    "min_experience_years": 0.0,
    "education_requirements": "",
}


def _as_skill_list(value) -> list:
    if isinstance(value, str):
        parts = [p.strip().lower() for p in value.replace(";", ",").split(",")]
    elif isinstance(value, (list, tuple)):
        parts = [str(p).strip().lower() for p in value]
    else:
        parts = []
    return [p for p in parts if p]


def normalize_job(job: dict) -> dict:
    job = job or {}
    norm = dict(DEFAULT_JOB)
    for k in ("title", "company", "jd_text", "education_requirements"):
        if job.get(k):
            norm[k] = str(job[k]).strip()
    norm["required_skills"] = _as_skill_list(job.get("required_skills"))
    norm["preferred_skills"] = _as_skill_list(job.get("preferred_skills"))
    try:
        norm["min_experience_years"] = max(0.0, float(job.get("min_experience_years", 0) or 0))
    except (TypeError, ValueError):
        norm["min_experience_years"] = 0.0
    return norm


# ----------------------------------------------------------------------------
# Scoring components (each returns value 0..1 plus grounded evidence)
# ----------------------------------------------------------------------------

def _skills_component(resume_skills: list, required: list, preferred: list,
                      jd_skills: list, personalization: dict = None):
    """50% — required-skill coverage. Falls back to JD-extracted skills.

    When personalization is active, basis skills the recruiter has favoured
    get a modest importance boost (see ranker.py); every boost is disclosed.
    """
    basis = required or jd_skills
    basis_note = "required skills you listed" if required else "skills detected in the job description"
    if not basis:
        return {
            "value": 0.0, "basis": basis_note, "matched": [], "missing": [],
            "personalization": {"active": False, "adjustments": [], "note": ""},
            "detection_note": _DETECTION_NOTE,
            "note": "No skills to compare against — the job lists no skills and none were detected.",
        }
    rset, bset = set(resume_skills), set(basis)
    matched = sorted(rset & bset)
    missing = sorted(bset - rset)
    adjustments = []
    personalization_note = ""
    if personalization and personalization.get("active"):
        weights, adjustments = skill_weights(basis, personalization.get("skill_boosts"))
        denom = sum(weights[s] for s in basis) or 1.0
        value = sum(weights[s] for s in matched) / denom
        personalization_note = personalization.get("note", "")
    else:
        value = len(matched) / len(bset)
    pref_matched = sorted(rset & set(preferred)) if preferred else []
    pref_missing = sorted(set(preferred) - rset) if preferred else []
    return {
        "value": round(max(0.0, min(1.0, value)), 4),
        "basis": basis_note,
        "matched": matched,
        "missing": missing,
        "detection_note": _DETECTION_NOTE,
        "preferred_matched": pref_matched,
        "preferred_missing": pref_missing,
        "personalization": {
            "active": bool(adjustments),
            "decisions": (personalization or {}).get("decisions", 0),
            "adjustments": adjustments,
            "note": personalization_note,
        },
        "note": f"{len(matched)} of {len(bset)} {basis_note} found in the resume.",
    }


def _jd_similarity_component(step4: dict):
    """25% — semantic similarity between resume and job description."""
    sim = (
        0.5 * step4.get("cosine_full_vs_jd", 0.0)
        + 0.3 * step4.get("cosine_skills_vs_jd", 0.0)
        + 0.2 * step4.get("cosine_experience_vs_jd", 0.0)
    )
    sim = max(0.0, min(1.0, sim))
    if sim >= 0.7:
        rel = "closely related"
    elif sim >= 0.5:
        rel = "related"
    elif sim >= 0.35:
        rel = "somewhat related"
    else:
        rel = "distant"
    return {
        "value": round(sim, 4),
        "relatedness": rel,
        "note": f"The resume reads as {rel} to the job description (meaning similarity {sim:.0%}).",
    }


def _experience_component(exp_years: float, min_exp: float):
    """15% — years of experience vs the role's minimum."""
    if min_exp <= 0:
        return {
            "value": 1.0, "meets": True,
            "note": f"{exp_years} years found; the role sets no minimum.",
        }
    value = min(1.0, exp_years / min_exp) if min_exp else 1.0
    meets = exp_years >= min_exp
    return {
        "value": round(value, 4),
        "meets": meets,
        "note": (f"{exp_years} years found; the role asks for {min_exp:g} — "
                 + ("requirement met." if meets else "below the requirement.")),
    }


def _norm_degree_token(tok: str) -> str:
    return tok.lower().replace(".", "").replace(" ", "")


def _education_component(degrees: list, edu_req: str):
    """10% — degree requirement keyword match. Identity-blind: only degree
    keywords are compared, never institution names."""
    reqs = [r.strip() for r in edu_req.replace(";", ",").split(",") if r.strip()]
    if not reqs:
        return {
            "value": 1.0, "matched_reqs": [], "missing_reqs": [],
            "note": "No specific degree required for this role.",
        }
    deg_text = " ".join(_norm_degree_token(d) for d in degrees)
    matched, missing = [], []
    for r in reqs:
        keys = [_norm_degree_token(k) for k in r.split() if len(k) > 1]
        hit = any(k and k in deg_text for k in keys) if keys else False
        (matched if hit else missing).append(r)
    value = len(matched) / len(reqs)
    return {
        "value": round(value, 4),
        "matched_reqs": matched,
        "missing_reqs": missing,
        "note": (f"Degree requirement {', '.join(matched)} found in resume."
                 if matched and not missing else
                 f"Found: {', '.join(matched)}; not found: {', '.join(missing)}."
                 if matched else
                 f"None of the required degrees ({', '.join(reqs)}) found in resume."),
    }


def band_for(score: float) -> str:
    if score >= 0.65:
        return "Strong match"
    if score >= 0.40:
        return "Worth reviewing"
    return "Weak match"


# ----------------------------------------------------------------------------
# Candidate assembly
# ----------------------------------------------------------------------------

FAIRNESS_NOTE = (
    "Scoring uses only extracted skills, resume-to-job-description meaning "
    "similarity, years of experience, and degree keywords. Names, colleges, "
    "contact details and other identity markers are never used. Statuses are "
    "set by people, not by scores — a low score never rejects a candidate."
)


def build_candidate(resume_id: str, filename: str, job: dict, stages: dict,
                    personalization: dict = None) -> dict:
    s3 = stages["step3_preprocessing"]
    s4 = stages["step4_vectors"]
    s5 = stages["step5_matching"]
    s2 = stages["step2_extraction"]

    resume_skills = s3.get("skills_found", [])
    jd_skills = s5.get("jd_skills_detected", [])
    exp_years = s3.get("experience_years", 0.0)
    degrees = s3.get("degrees", [])
    personal = s3.get("personal", {"name": "", "email": "", "phone": ""})

    skills = _skills_component(resume_skills, job["required_skills"],
                               job["preferred_skills"], jd_skills, personalization)
    jd_sim = _jd_similarity_component(s4)
    exp = _experience_component(exp_years, job["min_experience_years"])
    edu = _education_component(degrees, job["education_requirements"])

    contributions = {
        "skills": round(0.50 * skills["value"], 4),
        "jd_similarity": round(0.25 * jd_sim["value"], 4),
        "experience": round(0.15 * exp["value"], 4),
        "education": round(0.10 * edu["value"], 4),
    }
    score = round(sum(contributions.values()), 4)
    band = band_for(score)

    # Grounded explanation — every sentence cites extracted evidence only.
    explanation = []
    n_req = len(skills["matched"]) + len(skills["missing"])
    if n_req:
        explanation.append(
            f"Skills (50% of the score): {len(skills['matched'])} of {n_req} "
            f"{skills['basis']} found — {', '.join(skills['matched']) or 'none'}."
            + (f" Not detected in the resume: {', '.join(skills['missing'])}." if skills["missing"] else "")
        )
    else:
        explanation.append("Skills (50% of the score): nothing to compare — " + skills["note"])
    explanation.append(f"Job description fit (25%): {jd_sim['note']}")
    explanation.append(f"Experience (15%): {exp['note']}")
    explanation.append(f"Education (10%): {edu['note']}")
    if band == "Strong match":
        verdict = (f"Overall {score:.0%} — a strong match on the evidence above. "
                   "Still worth a human read before shortlisting.")
    elif band == "Worth reviewing":
        verdict = (f"Overall {score:.0%} — worth a closer look. "
                   "The gaps above show exactly what to probe in a conversation.")
    else:
        verdict = (f"Overall {score:.0%} — not a strong match for this role as described. "
                   "The ranking assists you; the decision is yours.")
    explanation.append(verdict)

    # Learned-ranker disclosure: every personalization influence is stated
    # in plain language, grounded in the recruiter's own recorded decisions.
    personalization_info = {
        "active": False,
        "decisions": 0,
        "note": "",
        "adjustments": [],
    }
    pers = skills.get("personalization") or {}
    if pers.get("active") and pers.get("adjustments"):
        personalization_info = {
            "active": True,
            "decisions": pers.get("decisions", 0),
            "note": pers.get("note", ""),
            "adjustments": pers["adjustments"],
        }
        explanation.append("Personalized to your decisions: " + pers.get("note", ""))
        for adj in pers["adjustments"]:
            explanation.append("• " + adj["note"])

    sections_text = s2.get("sections_text", {})

    return {
        "resume_id": resume_id,
        "filename": filename,
        "personal": personal,
        "score": score,
        "band": band,
        "components": {
            "skills": {"weight": 0.50, "value": skills["value"],
                       "points": int(round(contributions["skills"] * 100)),
                       "label": "Skills match",
                       "detail": skills["note"],
                       "matched": skills["matched"], "missing": skills["missing"],
                       "detection_note": skills.get("detection_note", _DETECTION_NOTE),
                       "preferred_matched": skills.get("preferred_matched", []),
                       "preferred_missing": skills.get("preferred_missing", [])},
            "jd_similarity": {"weight": 0.25, "value": jd_sim["value"],
                              "points": int(round(contributions["jd_similarity"] * 100)),
                              "label": "Job description fit",
                              "detail": jd_sim["note"]},
            "experience": {"weight": 0.15, "value": exp["value"],
                           "points": int(round(contributions["experience"] * 100)),
                           "label": "Experience",
                           "detail": exp["note"]},
            "education": {"weight": 0.10, "value": edu["value"],
                          "points": int(round(contributions["education"] * 100)),
                          "label": "Education",
                          "detail": edu["note"]},
        },
        "explanation": explanation,
        "matched_skills": skills["matched"],
        "missing_skills": skills["missing"],
        "detection_note": skills.get("detection_note", _DETECTION_NOTE),
        "warnings": stages["step7_result"].get("warnings", []),
        "experience_years": exp_years,
        "degrees": degrees,
        "job_titles": s3.get("job_titles", []),
        "sections": {
            "summary": sections_text.get("summary", ""),
            "experience": sections_text.get("experience", ""),
            "education": sections_text.get("education", ""),
            "projects": sections_text.get("projects", ""),
            "certifications": sections_text.get("certifications", ""),
        },
        "meets_experience_requirement": exp_years >= job["min_experience_years"],
        "fairness_note": FAIRNESS_NOTE,
        "personalization": personalization_info,
        "created_at": stages["step7_result"].get("created_at", ""),
    }


def ranking_row(candidate: dict) -> dict:
    return {
        "resume_id": candidate["resume_id"],
        "filename": candidate["filename"],
        "name": candidate["personal"].get("name", ""),
        "score": candidate["score"],
        "band": candidate["band"],
        "matched_skills": candidate["matched_skills"],
        "missing_skills": candidate["missing_skills"],
        "experience_years": candidate["experience_years"],
    }


def screen_one_resume(file_bytes: bytes, filename: str, job: dict, resume_id: str,
                      personalization: dict = None, pre_extracted_text: str = None):
    """Generator yielding ('stage', {...}) per completed stage, then
    ('candidate', candidate_dict) — or ('error', {'message': ...}) when text
    extraction failed, so a bad file is never scored as a weak match.
    Shares the exact pipeline as /api/analyze."""
    stages = {}
    for key, out in run_pipeline_stages(file_bytes, filename, job["jd_text"],
                                       job["min_experience_years"],
                                       pre_extracted_text=pre_extracted_text):
        stages[key] = out
        yield ("stage", {
            "stage": key,
            "label": STAGE_LABELS[key],
            "status": "done",
            "summary": stage_summary(key, out),
            "detail": out,
        })
    extraction_error = stages.get("step2_extraction", {}).get("extraction_error")
    if extraction_error:
        yield ("error", {"message": extraction_error, "filename": filename})
        return
    yield ("candidate", build_candidate(resume_id, filename, job, stages, personalization))
