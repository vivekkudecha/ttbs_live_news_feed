#!/usr/bin/env bash
set -e

# Wait for MySQL database if alembic migration or backend startup is requested
wait_for_db() {
    echo "Waiting for MySQL database to become ready..."
    max_retries=30
    count=0
    until python -c "
import sys
from sqlalchemy import create_engine, text
from app.core.config import get_settings

try:
    engine = create_engine(get_settings().database_url, pool_pre_ping=True)
    with engine.connect() as conn:
        conn.execute(text('SELECT 1'))
    print('MySQL database is ready and accepting queries!')
    sys.exit(0)
except Exception as e:
    sys.exit(1)
" 2>/dev/null; do
        count=$((count + 1))
        if [ $count -ge $max_retries ]; then
            echo "Error: Database connection timed out after $max_retries attempts."
            exit 1
        fi
        echo "Database is still unavailable, retrying in 2 seconds... ($count/$max_retries)"
        sleep 2
    done
}

if [ "$1" = "alembic" ] || [ "$1" = "migrate" ]; then
    wait_for_db
    echo "Applying database migrations (alembic upgrade head)..."
    shift
    if [ "$1" = "upgrade" ] || [ "$1" = "head" ]; then
        exec alembic upgrade head
    else
        exec alembic "$@"
    fi
fi

exec "$@"

