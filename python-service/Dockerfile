FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

# Run under an unprivileged account with writable data & upload directories
RUN groupadd -r appgroup && useradd -r -g appgroup -d /app -s /sbin/nologin appuser \
    && mkdir -p /app/data /app/uploads \
    && chown -R appuser:appgroup /app

# Accounts, sessions, library and history live in this file, so it has to
# outlive the container.
ENV SC_DB_PATH=/app/data/streamapp.db
ENV SC_UPLOAD_DIR=/app/uploads
VOLUME ["/app/data", "/app/uploads"]

USER appuser
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
