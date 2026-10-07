from __future__ import annotations

import os
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    redis_url: str
    jwt_secret: str
    redis_key_prefix: str
    r2_account_id: str = ""
    r2_bucket: str = ""
    r2_access_key_id: str = ""
    r2_secret_access_key: str = ""
    r2_endpoint: str = ""

    @classmethod
    def from_env(cls) -> Settings:
        database_url = os.getenv("DATABASE_URL", "")
        redis_url = os.getenv("REDIS_URL", "")
        jwt_secret = os.getenv("JWT_SECRET", "")
        if not database_url or not redis_url or len(jwt_secret) < 32:
            raise RuntimeError("DATABASE_URL, REDIS_URL and JWT_SECRET (>=32 chars) are required")
        if os.getenv("NODE_ENV") == "production" and jwt_secret.startswith("local-"):
            raise RuntimeError("Local JWT secret cannot be used in production")
        return cls(
            database_url=database_url,
            redis_url=redis_url,
            jwt_secret=jwt_secret,
            redis_key_prefix=os.getenv("REDIS_KEY_PREFIX", "alobo:"),
            r2_account_id=os.getenv("R2_ACCOUNT_ID", ""),
            r2_bucket=os.getenv("R2_BUCKET", ""),
            r2_access_key_id=os.getenv("R2_ACCESS_KEY_ID", ""),
            r2_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY", ""),
            r2_endpoint=os.getenv("R2_ENDPOINT", ""),
        )

    @property
    def r2_configured(self) -> bool:
        return all((self.r2_account_id, self.r2_bucket, self.r2_access_key_id, self.r2_secret_access_key))

    def r2_url(self) -> str:
        if not self.r2_configured:
            raise RuntimeError("R2 S3 credentials or bucket are not configured")
        if not re.fullmatch(r"[a-fA-F0-9]{32}", self.r2_account_id):
            raise RuntimeError("Invalid R2 account ID")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", self.r2_bucket):
            raise RuntimeError("Invalid R2 bucket")
        endpoint = self.r2_endpoint or f"https://{self.r2_account_id}.r2.cloudflarestorage.com"
        allowed = rf"https://{self.r2_account_id}(?:\.(?:eu|us|fedramp))?\.r2\.cloudflarestorage\.com"
        if not re.fullmatch(allowed, endpoint, re.IGNORECASE):
            raise RuntimeError("R2 endpoint must belong to the configured account")
        return endpoint
