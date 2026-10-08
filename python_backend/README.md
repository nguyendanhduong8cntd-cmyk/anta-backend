# FastAPI port (chạy song song, chưa thay NestJS)

Đây là bản chuyển đổi Python/FastAPI dùng chung PostgreSQL/PostGIS, Redis và SQL migrations với backend NestJS hiện có. Không đổi schema, không xóa dữ liệu, không tự chuyển Android sang cổng mới. Chạy ở `127.0.0.1:8000`; NestJS vẫn ở `127.0.0.1:3000`.

Đã port: health/readiness, catalog sports/branches/yard/services/search, favorites, content/config, xác thực JWT phiên hiện có, xem/sửa hồ sơ và logout, chủ sân presign PUT/complete/archive ảnh R2 và ảnh GET ký 10 phút trong catalog. Endpoint khác (OTP/login/refresh, booking/payment, commerce/chat/admin, worker/realtime) **chưa được port** và FastAPI không quảng cáo chúng là hoạt động. Không dùng FastAPI làm backend Android/production trước khi đạt parity và chạy integration test đầy đủ.

## Chạy bằng Docker

Từ `D:\hdv\backend`, giữ `.env` cục bộ như README gốc, rồi chạy:

```powershell
docker compose -f infra/compose.yaml --profile python up -d --build
```

FastAPI: `http://127.0.0.1:8000/api/v1`; Swagger: `http://127.0.0.1:8000/docs`; readiness: `GET /api/v1/health/ready`. Migration Python dùng đúng `migrations/*.sql`, SHA-256 checksum và PostgreSQL advisory lock giống runner TypeScript. Không chạy đồng thời thao tác thay schema thủ công.

## Chạy trên máy

```powershell
py -m venv python_backend/.venv
python_backend/.venv/Scripts/python.exe -m pip install -r python_backend/requirements.txt
$env:PYTHONPATH="python_backend"
python_backend/.venv/Scripts/python.exe -m anta_api.migrate
python_backend/.venv/Scripts/python.exe -m uvicorn anta_api.main:app --host 127.0.0.1 --port 8000 --env-file .env
```

Chỉ cấu hình R2 qua `.env`/secret manager; không đưa khóa vào Git hoặc log. FastAPI từ chối cấp URL PUT nếu thiếu S3 key. URL ký chứa quyền truy cập tạm thời, logger Android phải che tham số `X-Amz-*`.
