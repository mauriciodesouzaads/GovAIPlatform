"""
GovAI Platform — Presidio NLP Microservice (Tier 2 DLP)

Semantic PII detection using Microsoft Presidio + spaCy.
Called asynchronously by the Fastify DLP Engine when Tier 1 (Regex) passes.

Endpoints:
  POST /analyze  → Detect PII entities in text
  POST /anonymize → Detect and redact PII from text
  GET  /health   → Health check
"""

from fastapi import FastAPI
from pydantic import BaseModel
from typing import List, Optional

from presidio_analyzer import AnalyzerEngine, RecognizerResult
from presidio_anonymizer import AnonymizerEngine

app = FastAPI(title="GovAI Presidio NLP", version="1.0.0")

# Initialize engines once at startup
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()


class AnalyzeRequest(BaseModel):
    text: str
    language: str = "pt"
    entities: Optional[List[str]] = None  # e.g. ["PERSON", "LOCATION", "PHONE_NUMBER"]


class AnalyzeResponse(BaseModel):
    entities: List[dict]


class AnonymizeRequest(BaseModel):
    text: str
    language: str = "pt"


class AnonymizeResponse(BaseModel):
    anonymized_text: str
    entities_found: int


@app.get("/health")
async def health():
    return {"status": "ok", "engine": "presidio", "model": "pt_core_news_sm"}


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(req: AnalyzeRequest):
    """Detect PII entities without redacting."""
    results: List[RecognizerResult] = analyzer.analyze(
        text=req.text,
        language=req.language,
        entities=req.entities,
    )
    return AnalyzeResponse(
        entities=[
            {
                "type": r.entity_type,
                "start": r.start,
                "end": r.end,
                "score": round(r.score, 3),
                "text": req.text[r.start:r.end],
            }
            for r in results
        ]
    )


@app.post("/anonymize", response_model=AnonymizeResponse)
async def anonymize_text(req: AnonymizeRequest):
    """Detect and redact PII from text."""
    results = analyzer.analyze(text=req.text, language=req.language)
    anonymized = anonymizer.anonymize(text=req.text, analyzer_results=results)
    return AnonymizeResponse(
        anonymized_text=anonymized.text,
        entities_found=len(results),
    )
