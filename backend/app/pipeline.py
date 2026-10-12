"""Resume Screener NLP pipeline — implements the 8 documented steps.

Step 1: ingest        - file metadata
Step 2: extraction    - PDF (PyMuPDF, pdfplumber fallback) / DOCX -> text + sections
Step 3: preprocessing - spaCy tokenize/lemmatize, skill extraction (PhraseMatcher),
                        experience years (date ranges), degrees, job titles, PII strip
Step 4: vectors       - TF-IDF cosine + sentence-transformer embeddings per section
Step 5: matching      - hard experience filter, weighted score, bands, matched/missing skills
Step 6: transparency  - score breakdown, method + fairness notes
Step 7: output        - final assembled result
Step 8: feedback hook - returns analysis_id for POST /api/feedback

Resume text is never logged. PII (emails/phones) is redacted in any echoed text.
"""

import io
import json
import math
import re
import uuid
from datetime import datetime
from pathlib import Path

import pymupdf  # PyMuPDF
import pdfplumber
from docx import Document
import spacy
from spacy.matcher import PhraseMatcher
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from sentence_transformers import SentenceTransformer

# ----------------------------------------------------------------------------
# Lazy singletons (loaded once per process; pre-downloaded into the image
# during the Railway build so startup stays fast)
# ----------------------------------------------------------------------------

_nlp = None
_matcher = None
_skill_lookup = {}   # alias (lowercased) -> canonical
_model = None

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _load_nlp():
    global _nlp, _matcher, _skill_lookup
    if _nlp is not None:
        return
    _nlp = spacy.load("en_core_web_sm")
    with open(DATA_DIR / "skills.json", encoding="utf-8") as f:
        taxonomy = json.load(f)["skills"]
    # canonical -> set of aliases (merge duplicate canonical entries)
    merged = {}
    for entry in taxonomy:
        canon = entry["canonical"].strip().lower()
        merged.setdefault(canon, set()).add(entry["canonical"].strip().lower())
        for a in entry.get("aliases", []):
            merged[canon].add(a.strip().lower())
    _matcher = PhraseMatcher(_nlp.vocab, attr="LOWER")
    for canon, aliases in merged.items():
        patterns = [_nlp.make_doc(a) for a in aliases if a]
        if patterns:
            _matcher.add(canon, patterns)
    for canon, aliases in merged.items():
        for a in aliases:
            _skill_lookup.setdefault(a, canon)


def _load_model():
    global _model
    if _model is None:
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def ensure_models():
    _load_nlp()
    _load_model()


# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
PHONE_RE = re.compile(r"(\+?\d[\d\s\-().]{7,}\d)")
PII_REPLACEMENT = "[redacted]"


def strip_pii(text: str) -> str:
    text = EMAIL_RE.sub(PII_REPLACEMENT, text)
    text = PHONE_RE.sub(PII_REPLACEMENT, text)
    return text


def redact_echo(text: str, limit: int = 300) -> str:
    """Short, PII-stripped preview for display in step outputs."""
    return strip_pii(text)[:limit]


SECTION_PATTERNS = {
    "summary": r"(?im)^\s*(professional summary|summary|profile|objective|about me|career objective)\s*$",
    "experience": r"(?im)^\s*(work experience|professional experience|experience|employment history|work history|internship|internships)\s*$",
    "skills": r"(?im)^\s*(skills|technical skills|core skills|key skills|competencies|technologies|tech stack|skillset)\s*$",
    "education": r"(?im)^\s*(education|academic background|qualifications|academic qualifications|academics)\s*$",
    "projects": r"(?im)^\s*(projects|personal projects|key projects|academic projects|selected projects)\s*$",
    "certifications": r"(?im)^\s*(certifications|certificates|certification|courses|licenses)\s*$",
}

SECTION_NAMES = ("summary", "experience", "skills", "education", "projects", "certifications")

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9, "oct": 10,
    "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

DATE_RANGE_RE = re.compile(
    r"(?P<smon>[A-Za-z]{3,9})?\s*(?P<syear>(?:19|20)\d{2})\s*[–—\-to]+\s*"
    r"(?P<emon>[A-Za-z]{3,9})?\s*(?P<eyear>(?:19|20)\d{2}|present|current|now)",
    re.IGNORECASE,
)

DEGREE_RE = re.compile(
    r"\b(B\.?\s?Tech|M\.?\s?Tech|B\.?\s?E\.?|M\.?\s?E\.?|B\.?\s?Sc|M\.?\s?Sc|"
    r"B\.?\s?Com|M\.?\s?Com|BBA|MBA|BCA|MCA|Ph\.?\s?D|B\.?\s?A\.?|M\.?\s?A\.?|"
    r"Bachelor(?:'s)?(?:\s+of\s+\w+)?|Master(?:'s)?(?:\s+of\s+\w+)?|Diploma)\b",
    re.IGNORECASE,
)

TITLE_KEYWORDS = re.compile(
    r"\b(engineer|developer|analyst|manager|designer|consultant|intern|lead|"
    r"architect|scientist|specialist|executive|associate|director|administrator|"
    r"coordinator|assistant|officer|technician|tester|founder|head|vp|"
    r"president|cto|ceo)\b",
    re.IGNORECASE,
)

YEARS_MENTION_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?)\s*(?:of\s+)?(?:experience|exp)",
    re.IGNORECASE,
)


def split_sections(text: str) -> dict:
    """Split resume text into sections using heading regexes."""
    hits = []
    for name, pat in SECTION_PATTERNS.items():
        for m in re.finditer(pat, text):
            hits.append((m.start(), name, m.end()))
    hits.sort()
    sections = {k: "" for k in SECTION_NAMES}
    if not hits:
        sections["experience"] = text  # fallback: treat all as experience-ish body
        return sections
    for i, (start, name, end) in enumerate(hits):
        next_start = hits[i + 1][0] if i + 1 < len(hits) else len(text)
        chunk = text[end:next_start].strip()
        if name in sections:
            sections[name] = (sections[name] + "\n" + chunk).strip() if sections[name] else chunk
    return sections


OCR_CHAR_THRESHOLD = 50


def extract_text_pdf(data: bytes) -> tuple[str, str, bool]:
    """PyMuPDF primary; pdfplumber fallback; Tesseract OCR for scanned PDFs.

    Returns (text, method, ocr_used). A PDF whose extractable text is below
    the char threshold is treated as scanned and OCR'd.
    """
    text = ""
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            text = "\n".join(page.get_text() for page in doc)
    except Exception:
        text = ""
    if len(text.strip()) < OCR_CHAR_THRESHOLD:
        try:
            with pdfplumber.open(io.BytesIO(data)) as pdf:
                text = "\n".join(page.extract_text() or "" for page in pdf.pages)
            method = "pdfplumber (fallback)"
        except Exception:
            method = "pymupdf (failed)"
        if len((text or "").strip()) >= OCR_CHAR_THRESHOLD:
            return text or "", method, False
        # Scanned document: recover text with OCR.
        ocr_text, ocr_note = extract_text_pdf_ocr(data)
        if ocr_text.strip():
            return ocr_text, "tesseract ocr", True
        return text or "", f"{method}; {ocr_note}", False
    return text, "pymupdf", False


def extract_text_pdf_ocr(data: bytes) -> tuple[str, str]:
    """Render PDF pages to images and OCR them with Tesseract.

    Returns (text, note). Never raises for a missing binary — the caller
    falls back to whatever text was extractable.
    """
    try:
        import pytesseract
        from PIL import Image
    except Exception:
        return "", "ocr unavailable (ocr libraries missing)"
    try:
        pytesseract.get_tesseract_version()
    except Exception:
        return "", "ocr unavailable (tesseract binary missing)"
    try:
        texts = []
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            for page in doc:
                pix = page.get_pixmap(dpi=200)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                texts.append(pytesseract.image_to_string(img))
        return "\n".join(texts), "tesseract ocr"
    except Exception:
        return "", "ocr failed"


def extract_text_docx(data: bytes) -> str:
    doc = Document(io.BytesIO(data))
    return "\n".join(p.text for p in doc.paragraphs)


def extract_skills(text: str) -> list:
    _load_nlp()
    doc = _nlp(text.lower())
    found = set()
    for _match_id, start, end in _matcher(doc):
        span = doc[start:end].text.lower().strip()
        canon = _skill_lookup.get(span)
        if canon:
            found.add(canon)
    return sorted(found)


def _month_year_to_float(mon: str | None, year: str) -> float:
    m = MONTHS.get((mon or "").lower(), 1) if mon else 1
    return int(year) + (m - 1) / 12.0


def extract_experience_years(text: str) -> float:
    now = datetime.now()
    now_f = now.year + (now.month - 1) / 12.0
    total = 0.0
    ranges = []
    for m in DATE_RANGE_RE.finditer(text):
        s = _month_year_to_float(m.group("smon"), m.group("syear"))
        e_raw = (m.group("eyear") or "").lower()
        if e_raw in ("present", "current", "now"):
            e = now_f
        else:
            e = _month_year_to_float(m.group("emon"), e_raw)
        if 0 < e - s < 50:
            ranges.append((s, e))
    for s, e in ranges:
        total += e - s
    if total == 0:
        # fallback: "5 years of experience" style mentions
        mentions = [float(x) for x in YEARS_MENTION_RE.findall(text)]
        if mentions:
            total = max(mentions)
    return round(total, 1)


def extract_degrees(text: str) -> list:
    return sorted({m.group(0).strip() for m in DEGREE_RE.finditer(text)})


def extract_job_titles(experience_text: str) -> list:
    titles = []
    for line in experience_text.splitlines():
        line = line.strip(" •-*").strip()
        if 3 < len(line) < 80 and TITLE_KEYWORDS.search(line) and not DATE_RANGE_RE.search(line):
            titles.append(line)
    # dedupe preserving order
    seen, out = set(), []
    for t in titles:
        key = t.lower()
        if key not in seen:
            seen.add(key)
            out.append(t)
    return out[:10]


NAME_SKIP_RE = re.compile(r"(?i)\b(resume|curriculum vitae|\bcv\b|bio-?data|profile)\b")


def extract_personal_info(raw_text: str) -> dict:
    """Best-effort name/email/phone extraction. Empty strings when not found."""
    text = raw_text or ""
    email_m = EMAIL_RE.search(text)
    email = email_m.group(0) if email_m else ""
    phone = ""
    for m in PHONE_RE.finditer(text):
        digits = re.sub(r"\D", "", m.group(0))
        if 10 <= len(digits) <= 15:
            phone = m.group(0).strip()
            break
    name = ""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for ln in lines[:6]:
        words = ln.split()
        if (2 <= len(words) <= 4 and len(ln) <= 60
                and not re.search(r"\d|@|https?://", ln)
                and not NAME_SKIP_RE.search(ln)
                and all((not w[0].isalpha()) or w[0].isupper() for w in words)):
            name = ln.strip(" -|•")
            break
    if not name:
        _load_nlp()
        for ent in _nlp(text[:800]).ents:
            if ent.label_ == "PERSON":
                name = ent.text.strip()
                break
    return {"name": name, "email": email, "phone": phone}


def _cos(a, b) -> float:
    import numpy as np

    denom = (np.linalg.norm(a) * np.linalg.norm(b)) or 1e-9
    return float(np.dot(a, b) / denom)


# ----------------------------------------------------------------------------
# Main pipeline
# ----------------------------------------------------------------------------

def run_pipeline_stages(file_bytes: bytes, filename: str, job_description: str,
                      min_experience_years: float = 0.0,
                      pre_extracted_text: str = None):
    """Run the 8 pipeline stages, yielding (stage_key, stage_output) as each completes.

    `analyze_resume` collects these into the classic full result dict, so both the
    regular endpoint and the streaming endpoint share one code path.

    `pre_extracted_text`: when the resume text is already available (e.g. a row
    from an uploaded CSV dataset), step 2 uses it directly instead of parsing a
    file. Every downstream stage is byte-identical to the file path.
    """
    ensure_models()
    analysis_id = uuid.uuid4().hex

    # ---- Step 1: ingest -----------------------------------------------------
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    step1 = {
        "analysis_id": analysis_id,
        "filename": filename,
        "file_type": ext,
        "file_size_bytes": len(file_bytes),
        "job_description_chars": len(job_description or ""),
        "min_experience_years": min_experience_years,
    }
    yield ("step1_ingest", step1)

    # ---- Step 2: extraction --------------------------------------------------
    jd_text = (job_description or "").strip()
    extraction_error = None
    if pre_extracted_text is not None:
        # CSV dataset row: text supplied directly, no file parsing involved.
        raw_text, method, ocr_used = pre_extracted_text, "csv_row", False
    elif not file_bytes:
        raw_text, method, ocr_used = "", "empty", False
        extraction_error = "No file content was received — the upload appears to be empty."
    elif ext == "pdf":
        raw_text, method, ocr_used = extract_text_pdf(file_bytes)
    elif ext in ("docx", "doc"):
        raw_text, method, ocr_used = extract_text_docx(file_bytes), "python-docx", False
    else:
        raw_text, method, ocr_used = "", "unsupported", False
        extraction_error = (
            f"Unsupported file type '.{ext}'. Upload a PDF or DOCX resume."
            if ext else "Could not determine the file type. Upload a PDF or DOCX resume."
        )
    raw_text = raw_text.strip()
    if extraction_error is None and not raw_text:
        extraction_error = (
            "No readable text could be extracted from this file. It may be empty, "
            "image-only (OCR recovered nothing), corrupted, or password-protected."
        )
    warnings = []
    if ocr_used:
        warnings.append("Scanned document — text was recovered with OCR and may contain errors.")
    sections = split_sections(raw_text) if raw_text else {k: "" for k in SECTION_NAMES}
    words_extracted = len(raw_text.split())
    if extraction_error is None and words_extracted < 30:
        warnings.append(
            f"Very little text extracted ({words_extracted} words) — results may be unreliable."
        )
    step2 = {
        "extraction_method": method,
        "ocr_used": ocr_used,
        "extraction_error": extraction_error,
        "chars_extracted": len(raw_text),
        "words_extracted": words_extracted,
        "sections_found": [k for k, v in sections.items() if v.strip()],
        "section_previews": {k: redact_echo(v) for k, v in sections.items() if v.strip()},
        "sections_text": {k: redact_echo(v, 4000) for k, v in sections.items() if v.strip()},
    }
    yield ("step2_extraction", step2)

    # ---- Step 3: preprocessing -----------------------------------------------
    _load_nlp()
    doc = _nlp(raw_text[:200000])  # cap for very long resumes
    tokens = [t.lemma_.lower() for t in doc if t.is_alpha and not t.is_stop]
    resume_skills = extract_skills(raw_text)
    jd_skills = extract_skills(jd_text)
    exp_years = extract_experience_years(raw_text)
    degrees = extract_degrees(sections["education"] or raw_text)
    titles = extract_job_titles(sections["experience"])
    if extraction_error is None:
        if not sections["skills"].strip():
            warnings.append("No dedicated skills section found — skills were searched across the whole document.")
        if not resume_skills:
            warnings.append("No recognizable skills detected in the resume.")
        if exp_years == 0:
            warnings.append("Could not determine years of experience from dates or mentions.")
        if not degrees:
            warnings.append("No degree information detected in the resume.")
    step3 = {
        "tokens_after_preprocessing": len(tokens),
        "unique_lemmas": len(set(tokens)),
        "skills_found": resume_skills,
        "skills_count": len(resume_skills),
        "experience_years": exp_years,
        "degrees": degrees,
        "job_titles": titles,
        "personal": extract_personal_info(raw_text),
        "pii_stripped": True,
    }
    yield ("step3_preprocessing", step3)

    # ---- Step 4: vectors -----------------------------------------------------
    model = _load_model()
    skills_text = sections["skills"] or " ".join(resume_skills)
    exp_text = sections["experience"] or raw_text
    emb_resume_full, emb_skills, emb_exp, emb_jd = model.encode(
        [raw_text[:8000] or " ", skills_text[:4000] or " ", exp_text[:8000] or " ", jd_text[:8000] or " "],
        convert_to_numpy=True,
    )
    sim_full = _cos(emb_resume_full, emb_jd)
    sim_skills = _cos(emb_skills, emb_jd)
    sim_exp = _cos(emb_exp, emb_jd)
    tfidf_sim = 0.0
    if raw_text.strip() and jd_text.strip():
        vec = TfidfVectorizer(max_features=5000).fit_transform([raw_text, jd_text])
        tfidf_sim = float(cosine_similarity(vec[0], vec[1])[0][0])
    step4 = {
        "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
        "tfidf_model": "scikit-learn TfidfVectorizer",
        "cosine_full_vs_jd": round(sim_full, 4),
        "cosine_skills_vs_jd": round(sim_skills, 4),
        "cosine_experience_vs_jd": round(sim_exp, 4),
        "tfidf_cosine": round(tfidf_sim, 4),
    }
    yield ("step4_vectors", step4)

    # ---- Step 5: matching / scoring ------------------------------------------
    skill_overlap = (len(set(jd_skills) & set(resume_skills)) / len(jd_skills)) if jd_skills else 0.0
    score = (
        0.35 * sim_full
        + 0.25 * sim_skills
        + 0.15 * sim_exp
        + 0.15 * skill_overlap
        + 0.10 * tfidf_sim
    )
    score = round(max(0.0, min(1.0, score)), 4)
    meets_experience = exp_years >= min_experience_years
    if score >= 0.65:
        band = "Strong match"
    elif score >= 0.40:
        band = "Worth reviewing"
    else:
        band = "Weak match"
    matched = sorted(set(jd_skills) & set(resume_skills))
    missing = sorted(set(jd_skills) - set(resume_skills))
    if not jd_skills:
        warnings.append("No skills detected in the job description — skill matching has limited signal.")
    step5 = {
        "final_score": score,
        "band": band,
        "band_note": "Assessment, not a guarantee of job performance.",
        "detection_note": ("Skills listed as not detected were not found in the resume text. "
                           "'Not detected' is not proof the candidate lacks the skill."),
        "hard_filter": {
            "min_experience_years": min_experience_years,
            "candidate_experience_years": exp_years,
            "passed": meets_experience,
        },
        "score_weights": {"emb_full": 0.35, "emb_skills": 0.25, "emb_experience": 0.15,
                          "skill_overlap": 0.15, "tfidf": 0.10},
        "skill_overlap_ratio": round(skill_overlap, 4),
        "jd_skills_detected": jd_skills,
        "matched_skills": matched,
        "missing_skills": missing,
    }
    yield ("step5_matching", step5)

    # ---- Step 6: transparency -------------------------------------------------
    step6 = {
        "method": ("Weighted combination of semantic embedding similarity (SBERT), "
                   "skill-taxonomy overlap, and TF-IDF keyword similarity."),
        "score_breakdown": {
            "emb_full_x0.35": round(0.35 * sim_full, 4),
            "emb_skills_x0.25": round(0.25 * sim_skills, 4),
            "emb_experience_x0.15": round(0.15 * sim_exp, 4),
            "skill_overlap_x0.15": round(0.15 * skill_overlap, 4),
            "tfidf_x0.10": round(0.10 * tfidf_sim, 4),
        },
        "fairness_note": ("Names, colleges, and other identity markers are not used in scoring. "
                          "Emails and phone numbers are redacted before any data is echoed. "
                          "Training-free similarity scoring avoids learning historical hiring bias."),
        "limitations": ("Demo-grade skill taxonomy (~200 skills); scanned PDFs are "
                        "OCR'd but unusual layouts may misread; "
                        "experience parsing is regex-based and approximate."),
    }
    yield ("step6_transparency", step6)

    # ---- Step 7: output assembly ----------------------------------------------
    step7 = {
        "analysis_id": analysis_id,
        "band": band,
        "score": score,
        "matched_skills": matched,
        "missing_skills": missing,
        "detection_note": step5["detection_note"],
        "experience_years": exp_years,
        "degrees": degrees,
        "job_titles": titles,
        "warnings": warnings,
        "meets_experience_requirement": meets_experience,
        "created_at": datetime.utcnow().isoformat() + "Z",
    }
    yield ("step7_result", step7)

    # ---- Step 8: feedback hook -------------------------------------------------
    step8 = {
        "analysis_id": analysis_id,
        "feedback_endpoint": "/api/feedback",
        "how": "POST {\"analysis_id\": \"<id>\", \"verdict\": \"good_fit\" | \"bad_fit\"} to record reviewer judgment.",
    }
    yield ("step8_feedback", step8)


# ----------------------------------------------------------------------------
# Stage metadata for the live streaming UI (plain-language labels)
# ----------------------------------------------------------------------------

STAGE_LABELS = {
    "step1_ingest": "Receiving your file",
    "step2_extraction": "Reading the text",
    "step3_preprocessing": "Finding your skills",
    "step4_vectors": "Comparing with the job",
    "step5_matching": "Scoring the match",
    "step6_transparency": "Explaining the score",
    "step7_result": "Preparing your report",
    "step8_feedback": "Ready for your feedback",
}

STAGE_ORDER = tuple(STAGE_LABELS.keys())


def stage_summary(stage_key: str, out: dict) -> str:
    """One-line, plain-language summary of a completed stage, from real outputs."""
    try:
        if stage_key == "step1_ingest":
            kb = out.get("file_size_bytes", 0) / 1024
            return f"{kb:.0f} KB received — ready to read"
        if stage_key == "step2_extraction":
            words = out.get("words_extracted", 0)
            nsec = len(out.get("sections_found", []))
            if out.get("ocr_used"):
                return (f"Scanned document — text recovered with OCR, {words:,} words "
                        "(may contain errors)")
            return f"{words:,} words extracted from {nsec} sections"
        if stage_key == "step3_preprocessing":
            n = out.get("skills_count", 0)
            yrs = out.get("experience_years", 0)
            return f"{n} skills found · {yrs} years of experience"
        if stage_key == "step4_vectors":
            return "Meaning comparison with the job computed"
        if stage_key == "step5_matching":
            pct = int(round(out.get("final_score", 0) * 100))
            return f"Match signals combined — {pct}/100 ({out.get('band', '')})"
        if stage_key == "step6_transparency":
            return "Explanation and fairness notes ready"
        if stage_key == "step7_result":
            return "Report assembled"
        if stage_key == "step8_feedback":
            return "Ready for your feedback"
    except Exception:
        pass
    return "Done"


def analyze_resume(file_bytes: bytes, filename: str, job_description: str,
                   min_experience_years: float = 0.0) -> dict:
    """Classic full result (unchanged shape) — collects the stage generator.

    Adds `processing_error` (None when extraction succeeded): callers should
    treat a non-None value as a failed analysis, not a valid weak match.
    """
    result: dict = {}
    analysis_id = None
    for key, out in run_pipeline_stages(file_bytes, filename, job_description,
                                       min_experience_years):
        result[key] = out
        if key == "step1_ingest":
            analysis_id = out["analysis_id"]
    processing_error = result.get("step2_extraction", {}).get("extraction_error")
    return {"analysis_id": analysis_id, "processing_error": processing_error, **result}
