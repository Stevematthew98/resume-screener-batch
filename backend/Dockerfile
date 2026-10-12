# Resume Screener backend — FastAPI + Tesseract OCR.
#
# Railway auto-detects this Dockerfile and uses it instead of Railpack
# (Railpack cannot install apt packages, which Tesseract needs).
# Keeps the previous deploy behaviour: models pre-downloaded at build time,
# HF caches under /app/models, uvicorn on $PORT.

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/app/models \
    SENTENCE_TRANSFORMERS_HOME=/app/models \
    TRANSFORMERS_CACHE=/app/models

# tesseract-ocr: system binary for scanned-PDF OCR (pytesseract drives it)
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .
RUN python -m spacy download en_core_web_sm && python download_models.py

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
