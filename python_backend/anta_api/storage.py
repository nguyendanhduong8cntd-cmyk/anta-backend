from __future__ import annotations

import io
import warnings
from urllib.parse import parse_qs, urlparse

import boto3
from botocore.config import Config
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings
from .core import ApiError


ALLOWED_MIME = {"image/jpeg", "image/png", "image/webp"}
MAX_UPLOAD_BYTES = 10_485_760
Image.MAX_IMAGE_PIXELS = 16_000_000


def sanitize_court_image(raw: bytes) -> tuple[bytes, int, int]:
    jpeg = raw.startswith(b"\xff\xd8\xff")
    png = raw.startswith(b"\x89PNG\r\n\x1a\n")
    webp = len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
    if not (jpeg or png or webp) or len(raw) > MAX_UPLOAD_BYTES:
        raise ApiError("INVALID_IMAGE", "Unsupported raster image", 400)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
                    raise ValueError("Animated or unsupported image")
                if source.width > 8000 or source.height > 8000 or source.width * source.height > 16_000_000:
                    raise ValueError("Image dimensions exceed limit")
                source.load()
                oriented = ImageOps.exif_transpose(source)
                oriented.thumbnail((2400, 2400), Image.Resampling.LANCZOS)
                # A fresh canvas strips metadata and prevents publishing the uploaded bytes.
                mode = "RGBA" if "A" in oriented.getbands() else "RGB"
                clean = Image.new(mode, oriented.size)
                clean.paste(oriented.convert(mode))
                output = io.BytesIO()
                clean.save(output, format="WEBP", quality=82, method=4)
                body = output.getvalue()
                if not body or len(body) > MAX_UPLOAD_BYTES:
                    raise ValueError("Processed image exceeds limit")
                return body, clean.width, clean.height
    except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise ApiError("INVALID_IMAGE", "Unsupported raster image", 400) from error


class R2Storage:
    def __init__(self, settings: Settings):
        try:
            endpoint = settings.r2_url()
        except RuntimeError as error:
            raise ApiError("INTEGRATION_NOT_CONFIGURED", str(error), 503) from error
        self.bucket = settings.r2_bucket
        self.client = boto3.client("s3", endpoint_url=endpoint, region_name="auto",
            aws_access_key_id=settings.r2_access_key_id, aws_secret_access_key=settings.r2_secret_access_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"},
                request_checksum_calculation="when_required", response_checksum_validation="when_required"))

    def presign_put(self, key: str, mime: str) -> str:
        url = self.client.generate_presigned_url("put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": mime}, ExpiresIn=120, HttpMethod="PUT")
        signed = parse_qs(urlparse(url).query).get("X-Amz-SignedHeaders", [""])[0].split(";")
        if "content-type" not in signed:
            raise ApiError("STORAGE_UNAVAILABLE", "R2 PUT Content-Type is not signed", 503)
        return url

    def presign_get(self, key: str) -> str:
        return self.client.generate_presigned_url("get_object",
            Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=600, HttpMethod="GET")

    def head(self, key: str) -> dict:
        return self.client.head_object(Bucket=self.bucket, Key=key)

    def read_bounded(self, key: str, limit: int) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        stream = response["Body"]
        try:
            raw = stream.read(limit + 1)
            if len(raw) > limit:
                raise ApiError("UPLOAD_TOO_LARGE", "Uploaded file exceeds declared size", 400)
            return raw
        finally:
            stream.close()

    def put_clean(self, key: str, body: bytes) -> None:
        self.client.put_object(Bucket=self.bucket, Key=key, Body=body,
            ContentType="image/webp", CacheControl="private, max-age=600")
