import io
from urllib.parse import parse_qs, urlparse

import pytest
from PIL import Image

from anta_api.config import Settings
from anta_api.core import ApiError
from anta_api.storage import R2Storage, sanitize_court_image


def test_sanitize_decodes_and_reencodes_without_metadata():
    source = Image.new("RGB", (20, 10), "#228833")
    output = io.BytesIO()
    source.save(output, "PNG", pnginfo=None)
    body, width, height = sanitize_court_image(output.getvalue())
    assert (width, height) == (20, 10)
    with Image.open(io.BytesIO(body)) as image:
        assert image.format == "WEBP"


def test_sanitize_rejects_disguised_svg():
    with pytest.raises(ApiError) as error:
        sanitize_court_image(b'<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    assert error.value.code == "INVALID_IMAGE"


def test_r2_presigned_put_binds_content_type_without_network():
    settings = Settings(database_url="unused", redis_url="unused", jwt_secret="x" * 32,
        redis_key_prefix="test:", r2_account_id="a" * 32, r2_bucket="anta-court-images",
        r2_access_key_id="fake-access-key", r2_secret_access_key="fake-secret-key")
    storage = R2Storage(settings)
    url = storage.presign_put("quarantine/courts/example", "image/png")
    params = parse_qs(urlparse(url).query)
    assert "content-type" in params["X-Amz-SignedHeaders"][0].split(";")
    assert params["X-Amz-Expires"] == ["120"]
    assert "X-Amz-Signature" in params
    assert "X-Amz-Signature" in storage.presign_get("courts/example.webp")


def test_r2_refuses_missing_credentials_and_untrusted_endpoint():
    base = dict(database_url="unused", redis_url="unused", jwt_secret="x" * 32,
        redis_key_prefix="test:", r2_account_id="a" * 32, r2_bucket="anta-court-images")
    with pytest.raises(ApiError):
        R2Storage(Settings(**base))
    with pytest.raises(ApiError):
        R2Storage(Settings(**base, r2_access_key_id="fake", r2_secret_access_key="fake",
            r2_endpoint="https://example.org"))
