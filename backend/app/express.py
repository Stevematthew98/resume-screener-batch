# ----------------------------------------------------------------------------
# Express dataset mode — vectorized rapid scoring for large CSV datasets.
#
# Same 50/25/15/10 weighting philosophy as the deep pipeline, but computed
# with TF-IDF + taxonomy keyword matching instead of spaCy NER and MiniLM
# embeddings, so thousands of resumes score in seconds. Results are always
# labeled "express" and must never be presented as deep-pipeline scores.
# ----------------------------------------------------------------------------

import json
import os
import re
import time

import numpy as np

METHOD_NOTE = (
    "Express dataset scan: TF-IDF keyword similarity + taxonomy skill matching. "
    "Same 50/25/15/10 weighting as the standard pipeline, but this is a rapid "
    "scan — not the deep 8-stage NLP pipeline (no spaCy NER, no MiniLM embeddings)."
)


def _to_py(v):
    """Convert numpy scalars/containers to plain Python types.

    numpy scalar types (e.g. np.float64 from the vectorized scoring) are
    float subclasses, so JSON output works — but DB drivers (psycopg2)
    cannot adapt them as bind parameters. Sanitize before persistence.
    """
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, dict):
        return {k: _to_py(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_to_py(x) for x in v]
    return v


def _band_for(score: float) -> str:    # Same thresholds as the deep pipeline's band_for.
    if score >= 0.65:
        return "Strong match"
    if score >= 0.40:
        return "Worth reviewing"
    return "Weak match"

EXPRESS_MAX_ROWS = 5000

_taxonomy = None
_base_terms = None  # (alts, canon_of) cached


def _load_taxonomy():
    global _taxonomy
    if _taxonomy is None:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "..", "data", "skills.json"), encoding="utf-8") as f:
            _taxonomy = json.load(f)["skills"]
    return _taxonomy


def _taxonomy_base():
    """(all taxonomy terms longest-first, term.lower() -> canonical). Cached."""
    global _base_terms
    if _base_terms is None:
        alts, canon_of = [], {}
        for s in _load_taxonomy():
            for term in [s["canonical"]] + s.get("aliases", []):
                t = term.strip()
                if t and t.lower() not in canon_of:
                    alts.append(t)
                    canon_of[t.lower()] = s["canonical"]
        _base_terms = (alts, canon_of)
    return _base_terms


def build_matcher(extra_terms=()):
    """Compile a single skill regex.

    extra_terms: required-skill literals from the job roles (covers skills the
    taxonomy lacks, e.g. HR terms). Returns (pattern, canon_map).
    """
    alts, canon_of = _taxonomy_base()
    all_terms = list(alts)
    cmap = dict(canon_of)
    for t in extra_terms:
        tl = (t or "").strip().lower()
        if tl and tl not in cmap:
            all_terms.append(t.strip())
            cmap[tl] = t.strip()
    all_terms.sort(key=len, reverse=True)
    pat = re.compile(
        r"(?<![A-Za-z0-9+#])(" + "|".join(re.escape(a) for a in all_terms) + r")"
        r"(?![A-Za-z0-9+#])",
        re.IGNORECASE,
    )
    return pat, cmap


def canonicalize(term, cmap):
    tl = (term or "").strip().lower()
    return cmap.get(tl, (term or "").strip().lower())


_EXP_PAT = re.compile(r"(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b", re.IGNORECASE)


def extract_years(text):
    """Rough years-of-experience proxy: max plausible 'N years' mention."""
    vals = []
    for m in _EXP_PAT.findall((text or "")[:4000]):
        try:
            v = float(m)
        except ValueError:
            continue
        if 0 < v <= 50:
            vals.append(v)
    return max(vals) if vals else 0.0


def run_express(rows, roles):
    """Score every resume against every role.

    rows:  [(ext_id, name, category, text), ...]
    roles: [{"title": str, "required_skills": [str], "min_experience_years": float}]
    Returns a JSON-serializable result dict.
    """
    t0 = time.time()
    n = len(rows)
    if n == 0:
        raise ValueError("No resumes to score.")
    if not roles:
        raise ValueError("At least one job role is required.")

    # Normalize roles.
    norm_roles = []
    for r in roles:
        req = [s.strip() for s in (r.get("required_skills") or []) if s and s.strip()]
        norm_roles.append({
            "title": (r.get("title") or "Role").strip()[:80],
            "required_skills": req,
            "min_experience_years": float(r.get("min_experience_years") or 0),
        })

    # Skill matcher (taxonomy + role skill literals).
    raw_terms = {s for r in norm_roles for s in r["required_skills"]}
    pat, cmap = build_matcher(raw_terms)
    role_reqs = [[cmap.get(s.lower(), s.lower()) for s in r["required_skills"]]
                 for r in norm_roles]

    # 1) Skill scan — one regex pass per resume.
    resume_skills = []
    for _, _, _, text in rows:
        found = {cmap[m.group(1).lower()] for m in pat.finditer((text or "").lower())}
        resume_skills.append(found)

    # 2) TF-IDF cosine: resumes vs role docs.
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.metrics.pairwise import cosine_similarity
    docs = [t for _, _, _, t in rows]
    role_docs = [r["title"] + " " + " ".join(r["required_skills"]) for r in norm_roles]
    vec = TfidfVectorizer(max_features=20000, stop_words="english")
    mat = vec.fit_transform(docs + role_docs)
    sims = cosine_similarity(mat[:n], mat[n:])
    sims = np.clip(sims, 0.0, 1.0)

    # 3) Experience (vectorized).
    exps = np.array([extract_years(t) for _, _, _, t in rows])

    # 4) Score.
    candidates = []
    for i, (ext_id, name, category, _) in enumerate(rows):
        per_role = []
        for j, role in enumerate(norm_roles):
            req = role_reqs[j]
            rset = resume_skills[i]
            matched = sorted(set(req) & rset)
            missing = sorted(set(req) - rset)
            skill_v = (len(matched) / len(req)) if req else 0.0
            sim_v = float(sims[i, j])
            min_exp = role["min_experience_years"]
            exp_v = 1.0 if min_exp <= 0 else min(1.0, exps[i] / min_exp)
            edu_v = 1.0  # express roles carry no degree requirements
            score = round(0.50 * skill_v + 0.25 * sim_v + 0.15 * exp_v + 0.10 * edu_v, 4)
            exp_years = round(float(exps[i]), 1)
            per_role.append({
                "role": role["title"],
                "score": score,
                "band": _band_for(score),
                "matched": matched,
                "missing": missing,
                "exp_years": exp_years,
                # Per-resume analysis, mirroring the deep pipeline's component shape
                # (same 50/25/15/10 weights) so the frontend renders it the same way.
                "skill_gap_pct": round((1.0 - skill_v) * 100, 1),
                "components": {
                    "skills": {
                        "label": "Skills",
                        "points": round(50 * skill_v, 1),
                        "detail": f"{len(matched)} of {len(req)} required skills detected in the resume text",
                    },
                    "jd_similarity": {
                        "label": "Role similarity",
                        "points": round(25 * sim_v, 1),
                        "detail": "TF-IDF keyword overlap between the resume and the role's skill profile",
                    },
                    "experience": {
                        "label": "Experience",
                        "points": round(15 * exp_v, 1),
                        "detail": (f"~{exp_years} years detected; role asks for {min_exp:g}"
                                   if min_exp > 0 else "No minimum experience set for this role"),
                    },
                    "education": {
                        "label": "Education",
                        "points": round(10 * edu_v, 1),
                        "detail": "Express roles carry no degree requirements",
                    },
                },
            })
        best = max(per_role, key=lambda d: d["score"])
        candidates.append({
            "id": ext_id,
            "name": name or "",
            "category": category or "",
            "scores": per_role,
            "best_role": best["role"],
            "best_score": best["score"],
        })

    elapsed = round(time.time() - t0, 2)
    return _to_py({
        "method": "express",
        "method_note": METHOD_NOTE,
        "elapsed_seconds": elapsed,
        "total_resumes": n,
        "roles": [r["title"] for r in norm_roles],
        "candidates": candidates,
    })
