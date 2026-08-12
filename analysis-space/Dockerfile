# Hugging Face Space, Docker SDK, CPU Basic (2 vCPU / 16 GB RAM / 50 GB disk).
FROM python:3.11-slim

# HF Spaces run the container as uid 1000; anything written at runtime must be
# owned by that user.
RUN useradd -m -u 1000 user
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PORT=7860

WORKDIR /home/user/app

COPY --chown=user requirements.txt ./
USER user
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user app.py train.py pyproject.toml ./
COPY --chown=user tpl ./tpl
# models/ is optional: present only when a trained artefact has been committed.
COPY --chown=user model[s] ./models

EXPOSE 7860

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7860/health', timeout=4).status==200 else 1)"

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--workers", "1"]
