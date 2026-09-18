import os
import psycopg

with psycopg.connect(os.environ['DATABASE_URL']) as db:
    # Serialize concurrent rollout/restart migrations and preserve existing data.
    db.execute('SELECT pg_advisory_xact_lock(584536)')
    db.execute('CREATE TABLE IF NOT EXISTS requirement(id bigserial PRIMARY KEY,title text NOT NULL)')
