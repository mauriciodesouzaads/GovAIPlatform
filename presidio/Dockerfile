FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    fastapi==0.115.0 \
    uvicorn[standard]==0.30.0 \
    presidio-analyzer==2.2.355 \
    presidio-anonymizer==2.2.355 \
    spacy==3.7.5

# Download Portuguese NLP High-Accuracy model (bake offline into image — no runtime download)
RUN python -m spacy download pt_core_news_lg

# Usuário não-root para princípio do menor privilégio
RUN groupadd -g 1001 presidio && \
    useradd -u 1001 -g presidio -s /bin/false -M presidio

COPY --chown=presidio:presidio app.py .

USER presidio

EXPOSE 5001

HEALTHCHECK --interval=15s --timeout=10s --start-period=60s --retries=5 \
    CMD python3 -c 'import urllib.request; urllib.request.urlopen("http://localhost:5001/health")' || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5001"]
