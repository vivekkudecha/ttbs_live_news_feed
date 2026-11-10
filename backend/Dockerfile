# ==============================================================================
# Stage 1: Builder - install dependencies into an isolated virtualenv
# ==============================================================================
# Fully qualified image names: Podman on RHEL refuses ambiguous short names in non-interactive builds.
FROM docker.io/library/python:3.12-slim AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

# Create isolated virtualenv for application dependencies
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install application dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source (shipped as plain Python)
COPY app/ ./app/

# Prune unneeded virtualenv files to minimize layer size
RUN find /opt/venv -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/venv -type f -name "*.pyc" -delete && \
    find /opt/venv -type f -name "*.pyo" -delete && \
    find /opt/venv -type d -name "tests" -exec rm -rf {} + 2>/dev/null || true && \
    find /opt/venv -type d -name "test" -exec rm -rf {} + 2>/dev/null || true

# ==============================================================================
# Stage 2: Compressed Minimal Runtime
# ==============================================================================
FROM docker.io/library/python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH="/app"

WORKDIR /app

# Copy stripped virtualenv from builder stage
COPY --from=builder /opt/venv /opt/venv

# Copy the application package (plain Python source) from builder
COPY --from=builder /build/app /app/app

# Copy database migrations, configuration, and entrypoint
COPY alembic.ini .
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Set executable permissions, create storage directory, and purge apt/tmp caches
# (sed strips CRLF in case the repo was checked out on Windows: a "\r" shebang breaks the container.)
# Runs as an unprivileged user; the uploads volume inherits this ownership on first mount.
# COPY keeps host file modes, so on a host with umask 027 (files rw-r-----) the unprivileged
# user could not read the code or run the entrypoint (exit 126). Normalise to world-readable.
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh && \
    chmod -R a+rX /app && \
    sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/storage/uploads && \
    groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app && \
    chown -R app:app /app/storage && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* /root/.cache

USER app

# Expose API port (8000) and Prometheus worker metrics port (9464)
EXPOSE 8000 9464

ENTRYPOINT ["docker-entrypoint.sh"]

# Default command runs the FastAPI application with Uvicorn
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
