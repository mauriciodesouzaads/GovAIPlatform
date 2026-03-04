FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi==0.115.0 \
    uvicorn[standard]==0.30.0 \
    presidio-analyzer==2.2.355 \
    presidio-anonymizer==2.2.355 \
    spacy==3.7.5

# Download Portuguese NLP model for Presidio
RUN python -m spacy download pt_core_news_sm

COPY app.py .

EXPOSE 5001

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001"]
