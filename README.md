# Alobo clone backend — local MVP

Backend mới theo [kiến trúc đã viết](docs/BACKEND_ARCHITECTURE.md), không gọi hoặc giả danh backend Alobo gốc. Đây là phần nền tảng + luồng đặt sân Phase 1; **chưa phải toàn bộ Phase 1/2/3 và chưa dùng được cho production**. Android hiện chưa nối với API này.

## Phần đã triển khai

- NestJS modular monolith; API, realtime gateway và worker chạy bằng 3 tiến trình riêng.
- PostgreSQL 16/PostGIS, schema theo module, migration có checksum và transaction; Redis/BullMQ.
- OTP development, đăng ký có verification, login email/E.164 phone, reset password, profile, device FCM token. Password dùng scrypt; JWT 15 phút; refresh token hash, xoay vòng, phát hiện reuse và thu hồi family/session.
- Sport, branch/yard/detail/services, search theo tên/bán kính PostGIS, pagination, favorites, giờ mở cửa theo `Asia/Ho_Chi_Minh`.
- Quote tính phía server, slot nguyên giờ 1–8 giờ, hold 5 phút, booking/history/cancel chưa thanh toán. Một bảng reservation chung + GiST exclusion constraint chặn hold/booking overlap. Booking không kéo dài deadline của hold.
- Idempotency cho hold, booking, payment intent và cancel; scope theo user, so sánh payload; booking status history.
- Payment **sandbox tự triển khai**, không phải sandbox của PayOS/VNPay. Không thu tiền, không tạo checkout/QR giả. Webhook HMAC trên raw bytes + timestamp 5 phút, dedupe, kiểm tra amount/currency; tiền đến muộn/cancel đưa vào `NEEDS_REVIEW`.
- Transactional outbox → BullMQ → notification inbox; preference, mark-read, optional Firebase Admin FCM adapter. FCM mặc định tắt, chưa kiểm thử giao nhận thật; có thể gửi lặp nếu crash, client phải dedupe `eventId`.
- SSE và Socket.IO phát domain event theo user, cursor bigint, replay sau reconnect, kiểm tra JWT/session. **Chưa có chat**. Hiện polling database mỗi 2 giây, không phải Redis fanout; chưa nghiệm thu tải lớn.
- Content/config/terms, request ID, structured log không ghi body/token/OTP/PII, validation, rate limit Redis, ownership checks, health/readiness, OpenAPI.

## Chạy local (PowerShell)

Cần Node 24 LTS, npm và Docker Desktop Linux engine. Trên máy này dùng `npm.cmd` để tránh execution policy của PowerShell. Lệnh dưới đây chạy trong `D:\hdv\backend`:

```powershell
npm.cmd ci
npm.cmd run setup:local
docker compose -f infra/compose.yaml up -d postgres redis
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run openapi
```

`setup:local` tạo `.env` từ template nếu chưa có, không ghi đè cấu hình cũ. Secret mẫu chỉ dùng trên localhost. Để thử đăng ký, bật `DEV_OTP_ENABLED=true` và đặt `DEV_ADMIN_KEY` ngẫu nhiên dài ít nhất 32 ký tự trong `.env`. Public OTP API không trả code; development endpoint yêu cầu key. Không bật tùy chọn này ở môi trường công khai.

Chạy trong ba terminal:

```powershell
npm.cmd run start:api
npm.cmd run start:worker
npm.cmd run start:realtime
```

Hoặc chạy toàn bộ bằng container:

```powershell
docker compose -f infra/compose.yaml --profile app up -d --build
```

- API: `http://127.0.0.1:3000/api/v1`.
- Swagger: `http://127.0.0.1:3000/docs`; JSON: `http://127.0.0.1:3000/docs-json`.
- Readiness: `GET /api/v1/health/ready`.
- Realtime: `http://127.0.0.1:3001`.
- PostgreSQL: localhost:55432; Redis: localhost:56379. Các port container chỉ bind localhost.
- Docker app profile **luôn là development**, không phải deployment production.

Dừng app bằng `docker compose -f infra/compose.yaml --profile app stop`. Không dùng `down -v` nếu cần giữ dữ liệu. PostgreSQL/Redis volumes được giữ lại.

## Thử luồng đặt sân

1. `POST /public/auth/otp/send` với `{identifier,purpose:"register"}`.
2. Chỉ ở development: `GET /dev/otp/{challengeId}` với header `X-Dev-Key` để lấy code.
3. `POST /public/auth/otp/verify` với `{challengeId,code}` lấy `verificationToken`.
4. `POST /public/auth/register` với `{identifier,password,displayName,deviceId,verificationToken}`. Password tối thiểu 10 ký tự; phone dùng E.164 (`+84...`).
5. Dùng `Authorization: Bearer <accessToken>` cho API protected. Tìm sport/branch, lấy yard và availability.
6. `POST /booking-holds` với `{yardId,startsAt,endsAt}`, header `Idempotency-Key`; thời gian ISO có offset, đúng giờ mở cửa, trong 90 ngày tới.
7. `POST /bookings` với `{holdId}` và key mới, lấy booking ID.
8. `POST /payment-intents` với `{bookingId}` và key mới. Retry cùng thao tác giữ nguyên key/payload; không tái dùng key cho payload khác.
9. Xác nhận sandbox bằng script có secret local (không đưa secret vào Android):

```powershell
npm.cmd run sandbox:pay -- <payment-intent-uuid>
```

`GET /bookings/{id}` phải trả `CONFIRMED`. Redirect/UI không được tự xác nhận paid. Cancel booking đã paid hiện trả `REFUND_POLICY_REQUIRED`, chưa thực hiện hoàn tiền.

Dữ liệu seed là **sân demo**, không phải chi nhánh thật: sport `10000000-0000-4000-8000-000000000001`, branch `30000000-0000-4000-8000-000000000001`, yard `40000000-0000-4000-8000-000000000001`, giá 180.000 VND/giờ. Seed không tạo admin hay tài khoản với mật khẩu mặc định.

## Realtime contract

SSE: `GET http://127.0.0.1:3001/api/v1/events` với Bearer header và `Last-Event-ID` (hoặc query `after`). Event tên `domain.event`, gồm `id,type,payload,created_at,request_id`; heartbeat mỗi 2 giây, retry 3 giây. Không truyền JWT qua query string. Cursor là **chuỗi số**, không ép sang JavaScript Number.

Socket.IO: handshake `auth: {token: accessToken, after: "last-event-id"}`; lắng nghe `domain.event`. Client lưu cursor **sau khi xử lý** và dedupe theo ID. Reconnect phải gửi lại cursor đã xử lý. JWT hết hạn hoặc session revoke sẽ đóng stream/socket. Hiện không có message/conversation/E2E endpoints.

## Kiểm thử

Integration test chỉ chạy database có tên kết thúc `_test`; fixture riêng mỗi lần chạy và Redis key prefix riêng, không xóa database hoặc flush Redis.

```powershell
docker compose -f infra/compose.yaml exec -T postgres psql -U alobo -d postgres -c "CREATE DATABASE alobo_test"
npm.cmd test
npm.cmd run test:integration
npm.cmd run typecheck
npm.cmd audit --omit=dev
```

Chỉ tạo `alobo_test` một lần; nếu đã tồn tại bỏ qua lệnh CREATE DATABASE. CI được cấu hình ở [backend.yml](.github/workflows/backend.yml); cần xem kết quả trên GitHub sau lần push đầu tiên.

Đã test database thật: tranh slot, exclusion constraint khi bỏ qua application lock, adjacent slots, retry/idempotency hash, OTP attempts, refresh reuse, ownership, webhook invalid/duplicate/amount, cancel, expiry/late payment, outbox/notification, OpenAPI validation, SSE/Socket replay.

## Phần còn lại của kiến trúc

| Phạm vi | Trạng thái |
|---|---|
| Android API client/DTO generation, bind dữ liệu vào UI | Chưa triển khai; không thay đổi Android trong đợt backend này |
| SMS/email OTP thật, social login, linked account, deletion/re-auth | Chưa tích hợp; social trả 503; config production fail closed |
| Merchant payment thật, receipt/refund/reconciliation | Chưa có adapter/credential/policy; sandbox không thay thế provider thật |
| Membership, academy, social event/team/ticket, recurring booking | Phase 2 chưa triển khai |
| Commerce/order/voucher và add-on pricing | Phase 2 chưa triển khai |
| S3/media upload/scan, chat/moderation/E2E | Chưa triển khai; không dựng endpoint giả hoặc crypto tự chế |
| Admin/owner portal, tenant staff RBAC | Phase 3; hiện chỉ có consumer API kiểm tra ownership |
| Production deployment, TLS/gateway, PII encryption, backup/PITR/restore, metrics/tracing/load test | Chưa nghiệm thu |

Không cố deploy production bằng cách đổi `NODE_ENV`: config chủ động từ chối development OTP và sandbox payment. Cần hoàn thành provider adapters, quản lý secret, operational/security checklist trước.

## Migration và vận hành

Chạy migrate trước khi khởi động. Migration đã áp dụng không được sửa; thêm file đánh số tiếp theo. Runner dùng advisory lock và kiểm tra checksum. Không cung cấp destructive rollback tự động: dùng forward migration tương thích ngược, kiểm tra backup/restore trước thay đổi production. Không xóa booking/payment/audit để reset demo.

Outbox pending được retry mỗi 5 giây. BullMQ failed job được giữ lại để kiểm tra/retry, không tự xóa. PostgreSQL là nguồn dữ liệu chuẩn; Redis AOF không thay thế backup database. Worker/realtime chưa có readiness endpoint riêng hay dashboard; đây là việc còn lại trước triển khai vận hành.

Tham chiếu kỹ thuật: [PostgreSQL range/exclusion](https://www.postgresql.org/docs/16/rangetypes.html), [Nest validation](https://docs.nestjs.com/techniques/validation), [Nest raw body](https://docs.nestjs.com/faq/raw-body), [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
