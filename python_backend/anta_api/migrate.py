"""Apply the existing SQL migrations with the same checksums/lock as NestJS."""
from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import psycopg
from dotenv import load_dotenv


def apply_migrations(database_url: str, folder: Path) -> list[str]:
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtextextended('anta-migrations',0))")
        try:
            conn.execute("""CREATE TABLE IF NOT EXISTS public.schema_migrations(
                name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())""")
            for path in sorted(folder.iterdir()):
                if not re.fullmatch(r"\d+.*\.sql", path.name):
                    continue
                sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
                existing = conn.execute("SELECT checksum FROM public.schema_migrations WHERE name=%s",
                    (path.name,)).fetchone()
                if existing:
                    if existing[0] != checksum:
                        raise RuntimeError(f"Migration changed after applying: {path.name}")
                    continue
                with conn.transaction():
                    conn.execute(sql)
                    conn.execute("INSERT INTO public.schema_migrations(name,checksum) VALUES(%s,%s)",
                        (path.name, checksum))
                applied.append(path.name)
        finally:
            conn.execute("SELECT pg_advisory_unlock(hashtextextended('anta-migrations',0))")
    return applied


if __name__ == "__main__":
    load_dotenv()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")
    migrations = Path(__file__).resolve().parents[2] / "migrations"
    print({"applied": apply_migrations(database_url, migrations)})
