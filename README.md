# Alobo clone backend — implementation in progress

Backend mới theo [kiến trúc đã viết](docs/BACKEND_ARCHITECTURE.md), không gọi hoặc giả danh backend Alobo gốc. Android hiện chưa nối với API này.

**Cập nhật 07/10/2026.** Đã có: cổng thanh toán PayOS và VNPay, OTP qua SMTP/Twilio, hoàn tiền khi hủy, thanh toán gói thành viên/lớp học/vé, thư mục khóa E2E cho chat, tự động xóa dữ liệu tài khoản và portal quản trị tại `/admin`. Tất cả đã qua test với cổng giả lập; **chưa chạy với tài khoản merchant, SMTP, Twilio, R2 hay Firebase thật** vì chưa có khóa. Xem [Tích hợp thật](#tích-hợp-thật) để bật và kiểm tra.

Đang chuyển dần sang **Python/FastAPI**: bản chạy song song tại cổng 8000 đã có catalog/content, xác thực phiên JWT hiện có và ảnh sân R2. Các module còn lại vẫn ở NestJS; chưa chuyển Android hoặc thay thế cổng 3000. Xem [hướng dẫn FastAPI](python_backend/README.md).

## Phần đã triển khai

- NestJS modular monolith; API, realtime gateway và worker chạy bằng 3 tiến trình riêng.
- PostgreSQL 16/PostGIS, schema theo module, migration có checksum và transaction; Redis/BullMQ.
- OTP development, đăng ký có verification, login email/E.164 phone, reset password, profile, device FCM token. Password dùng scrypt; JWT 15 phút; refresh token hash, xoay vòng, phát hiện reuse và thu hồi family/session. Google login/link adapter xác thực Firebase ID token khi có service account; không tự động gộp tài khoản trùng email. Yêu cầu xóa tài khoản cần nhập lại mật khẩu, khóa tài khoản/thu hồi phiên ngay; **chưa tự động purge dữ liệu**.
- Sport, branch/yard/detail/services, search theo tên/bán kính PostGIS, pagination, favorites, giờ mở cửa theo `Asia/Ho_Chi_Minh`.
- Quote tính phía server, slot nguyên giờ 1–8 giờ, hold 5 phút, booking/history/cancel chưa thanh toán. Một bảng reservation chung + GiST exclusion constraint chặn hold/booking overlap. Booking không kéo dài deadline của hold. Có người tham gia, dịch vụ cộng thêm trước payment intent, đánh giá sau booking hoàn tất.
- Idempotency cho hold, booking, payment intent và cancel; scope theo user, so sánh payload; booking status history.
- Payment qua `PAYMENT_PROVIDER`: `sandbox` (tự triển khai, không thu tiền, không tạo checkout/QR giả), `payos` hoặc `vnpay`. Mọi cổng dùng chung một luồng: chỉ thông báo có chữ ký hợp lệ mới xác nhận, dedupe theo event, kiểm tra amount/currency; tiền đến muộn đưa vào `NEEDS_REVIEW` để admin hoàn.
- Transactional outbox → BullMQ → notification inbox; preference, mark-read, optional Firebase Admin FCM adapter. FCM mặc định tắt, chưa kiểm thử giao nhận thật; có thể gửi lặp nếu crash, client phải dedupe `eventId`.
- Đặt sân định kỳ theo tuần (2–12 tuần) tạo slot nguyên tử/idempotent; mỗi booking trong chuỗi cần thanh toán riêng. Membership miễn phí và dùng credit cho sự kiện, academy/lớp miễn phí, event/ticket QR, team/invitation/match result, order/voucher theo quota và thanh toán order bằng sandbox. Gói thành viên, lớp học và vé có giá tạo bản ghi `PENDING_PAYMENT` giữ chỗ 15 phút, thanh toán bằng `POST /payment-intents` với `contractId`/`enrollmentId`/`ticketId`, chỉ kích hoạt sau thông báo có chữ ký.
- Chat server-side có lời mời/nhận lời mời, kiểm tra thành viên, cursor/sequence, idempotency, pin/xóa và phát event realtime. Hội thoại tạo với `encrypted: true` chỉ nhận ciphertext theo từng thiết bị: server là thư mục khóa công khai theo giao thức Signal (X3DH + Double Ratchet) và không giải mã được. **Phần mã hóa phía Android chưa viết**, nên E2E chưa dùng được đầu-cuối.
- Cloudflare R2 private bucket cho ảnh sân: chủ chi nhánh nhận presigned **PUT**, server xác minh kích thước/MIME, đọc ảnh gốc từ quarantine, decode/re-encode thành WebP rồi mới gắn URL **GET có thời hạn** vào branch/yard. Ảnh gốc không được trả cho client. Media chung vẫn chờ review, không tự public.
- Admin API cấp/thu hồi role có scope chi nhánh và audit, bảo vệ role admin cuối cùng. Admin đầu tiên phải bootstrap thủ công bằng quy trình vận hành tin cậy; không có tài khoản admin mặc định.
- SSE và Socket.IO phát domain event theo user, cursor bigint, replay sau reconnect, kiểm tra JWT/session. Hiện polling database mỗi 2 giây, không phải Redis fanout; chưa nghiệm thu tải lớn.
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

`GET /bookings/{id}` phải trả `CONFIRMED`. Redirect/UI không được tự xác nhận paid. Hủy booking đã trả tiền hoàn theo chính sách: trước giờ chơi từ 24 giờ hoàn 100%, từ 2 đến dưới 24 giờ hoàn 50%, dưới 2 giờ từ chối với `CANCELLATION_WINDOW_CLOSED` (chỉnh bằng `REFUND_*`).

## Ảnh sân trên Cloudflare R2

Tạo private bucket `alobo-court-images` trong R2, rồi tạo **R2 S3 Access Key ID + Secret Access Key** có quyền Object Read & Write chỉ trên bucket đó. Điền `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` vào `.env` cục bộ hoặc secret manager; `.env.example` chỉ chứa account ID/bucket, không chứa khóa. Nếu bucket thuộc jurisdiction EU/US/FedRAMP, đặt thêm `R2_ENDPOINT` tương ứng. Không dùng token quản trị đã gửi trong chat làm khóa lưu trữ và nên thu hồi/đổi token đó.

Luồng API cho tài khoản `branch_owner`/`admin`:

1. `POST /api/v1/branches/{branchId}/images/presign` với `{ "mimeType": "image/jpeg", "size": 123456, "yardId": "..." }`; bỏ `yardId` nếu là ảnh chung của chi nhánh. API trả `method: PUT`, URL 120 giây và header `Content-Type` cần gửi nguyên vẹn.
2. Android/web `PUT` bytes ảnh trực tiếp tới URL ký, không gửi Bearer token backend đến R2. `size` phải đúng byte thực tế, tối đa 10 MiB. Nếu là browser, cấu hình CORS bucket cho origin và `PUT`/`Content-Type`.
3. `POST /api/v1/branches/{branchId}/images/{uploadId}/complete`. Backend HEAD/GET, kiểm tra chữ ký ảnh, giới hạn kích thước/pixel, xoay và chuyển sang WebP (tối đa 2400px). Chỉ ảnh xử lý thành công mới có trạng thái `CLEAN` và xuất hiện trong `GET /public/branches` hoặc `GET /public/branches/{id}`; ảnh yard nằm trong `yards[].images`.
4. `DELETE /api/v1/branches/{branchId}/images/{uploadId}` chỉ ẩn ảnh khỏi catalog; object không bị xóa vật lý. Cấu hình lifecycle xóa prefix `quarantine/` sau một khoảng lưu giữ thích hợp.

URL GET là bearer URL hết hạn sau 10 phút; client phải tải lại catalog khi hết hạn. Logger Android phải che các tham số `X-Amz-*` và không in nguyên URL PUT/GET có chữ ký. Chưa kiểm thử upload thực với R2 vì chưa có cặp S3 key mới và bucket chưa được xác nhận tồn tại.

Dữ liệu seed là **sân demo**, không phải chi nhánh thật: sport `10000000-0000-4000-8000-000000000001`, branch `30000000-0000-4000-8000-000000000001`, yard `40000000-0000-4000-8000-000000000001`, giá 180.000 VND/giờ. Seed không tạo admin hay tài khoản với mật khẩu mặc định.

Sau khi đăng ký tài khoản quản trị và xác minh quyền sở hữu qua quy trình vận hành ngoài API, người có quyền truy cập database có thể bootstrap admin đầu tiên bằng `INSERT INTO identity.roles(user_id,role) VALUES('<verified-user-uuid>','admin')`. Không chạy câu lệnh này với UUID chưa xác minh hoặc trong client Android. Các role tiếp theo cấp/thu hồi qua `/api/v1/admin/roles`, ghi audit.

## Tích hợp thật

Cấu hình trong `.env` (mẫu ở `.env.example`), không đưa khóa vào Git, Android hay log.

| Hạng mục | Bật bằng | Ghi chú |
|---|---|---|
| PayOS | `PAYMENT_PROVIDER=payos`, `PAYOS_*`, `PAYMENT_RETURN_URL` | Đăng ký webhook `/api/v1/webhooks/payments/payos`. PayOS không có API hoàn tiền: lệnh hoàn vào `MANUAL_REVIEW`, admin chuyển khoản rồi ghi nhận trong portal. |
| VNPay | `PAYMENT_PROVIDER=vnpay`, `VNPAY_*`, `PAYMENT_RETURN_URL` | Đăng ký IPN `/api/v1/webhooks/payments/vnpay/ipn`. Mặc định trỏ sandbox VNPay; đặt `VNPAY_PAY_URL`/`VNPAY_API_URL` cho production. Hoàn tiền gọi API refund từ worker. |
| OTP email | `OTP_DELIVERY=provider`, `SMTP_*` | Dùng cho identifier là email. |
| OTP SMS | `OTP_DELIVERY=provider`, `TWILIO_*` | Dùng cho số E.164. Thiếu kênh nào thì identifier loại đó trả 503. |
| R2, Firebase | `R2_*`, `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` | Như các mục bên dưới. |

Chỉ một cổng thanh toán hoạt động tại một thời điểm; webhook của cổng không được chọn trả 404. `URL trả về` không bao giờ xác nhận thanh toán.

Kiểm tra với tài khoản thật (mỗi test tự bỏ qua nếu thiếu biến môi trường của nó, ghi object dưới prefix `live-test/` rồi xóa):

```powershell
npm.cmd run test:live
```

Test Firebase cần thêm `FIREBASE_WEB_API_KEY`; test gửi OTP cần `LIVE_TEST_EMAIL`/`LIVE_TEST_PHONE` là hộp thư/số của chính bạn. Chữ ký PayOS/VNPay mới được kiểm bằng cổng giả lập trong test; cần chạy một giao dịch sandbox thật của từng cổng trước khi nhận tiền.

## Portal quản trị

`http://127.0.0.1:3000/admin/` phục vụ file tĩnh; mọi thao tác đi qua `/api/v1/admin/*` và yêu cầu role `admin`. Có: tổng quan, tìm người dùng và cấp/thu hồi role, danh sách đặt sân, giao dịch (hoàn tiền cho khoản đến muộn), hàng chờ hoàn tiền thủ công, yêu cầu xóa tài khoản và nhật ký audit. Admin đầu tiên vẫn bootstrap thủ công như mô tả bên dưới.

## Xóa tài khoản

Sau yêu cầu xóa 30 ngày, worker xóa thiết bị, phiên, liên kết Google, role, yêu thích, thông báo, khóa E2E; làm trống nội dung tin nhắn và bình luận; đổi identifier thành `deleted:<id>`. Booking, giao dịch, hoàn tiền và audit được giữ lại cho kế toán nhưng không còn gắn với danh tính. Tắt bằng `ACCOUNT_PURGE_ENABLED=false`. Bản sao lưu database không được xử lý.

## Realtime contract

SSE: `GET http://127.0.0.1:3001/api/v1/events` với Bearer header và `Last-Event-ID` (hoặc query `after`). Event tên `domain.event`, gồm `id,type,payload,created_at,request_id`; heartbeat mỗi 2 giây, retry 3 giây. Không truyền JWT qua query string. Cursor là **chuỗi số**, không ép sang JavaScript Number.

Socket.IO: handshake `auth: {token: accessToken, after: "last-event-id"}`; lắng nghe `domain.event` và `message.new`. Client lưu cursor **sau khi xử lý** và dedupe theo ID. Reconnect phải gửi lại cursor đã xử lý. JWT hết hạn hoặc session revoke sẽ đóng stream/socket. Có `message.send` nhưng chat hiện là plaintext trên server, không có E2E.

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

Đã test database thật: tranh slot, exclusion constraint, retry/idempotency, OTP/refresh, ownership, webhook/late payment, notification, SSE/Socket replay; thêm membership credit/QR một lần, lớp giới hạn chỗ, voucher quota/order payment, chat invitation/sequence, booking add-on/review, RBAC và thu hồi phiên khi yêu cầu xóa tài khoản. R2 signing/catalog binding dùng khóa giả trong integration test; upload thật cần credential/bucket. Google cũng chưa test provider end-to-end.

## Phần còn lại của kiến trúc

| Phạm vi | Trạng thái |
|---|---|
| Android API client/DTO generation, bind dữ liệu vào UI | Chưa triển khai; không thay đổi Android trong đợt backend này |
| SMS/email OTP thật | Có SMTP và Twilio; chưa gửi thử với tài khoản thật |
| Google login/linked account và xóa tài khoản | Code Firebase verify/revocation + explicit link đã có, chưa kiểm với project thật (`npm run test:live`). Purge tự động sau 30 ngày đã có; chính sách lưu trữ pháp lý và backup chưa xử lý |
| Merchant payment thật, receipt/refund/reconciliation | Có adapter PayOS/VNPay và hoàn tiền; chưa chạy với merchant thật, chưa có biên lai và đối soát định kỳ |
| Membership/academy/social | Flow miễn phí và có phí, credit, ticket QR, team, match/result, lớp/attendance đã có; tournament bracket chưa có. Hủy vé và hủy gói đã mua chưa có |
| Đặt sân định kỳ | Có booking series tuần, giữ chỗ đồng thời; chưa có thu tiền tự động/gộp cho cả chuỗi |
| Commerce/order/voucher và booking add-on | Có order/voucher quota, thanh toán và hoàn tiền trong 24 giờ, booking add-on tính phía server; biên lai chưa có |
| R2 ảnh sân/media chung | Ảnh sân decode/re-encode rồi publish bằng GET URL có thời hạn; media chung vẫn chờ review. R2 live test và chính sách/lifecycle cần làm |
| Chat/moderation/E2E | Plaintext chat, realtime và thư mục khóa/relay ciphertext E2E có; thiếu client mã hóa trên Android, attachment và moderation. E2E qua Socket.IO chưa hỗ trợ (dùng REST) |
| Admin/owner portal, tenant staff RBAC | Portal cho admin có; chưa có giao diện riêng cho chủ sân, bootstrap admin phải làm thủ công |
| Production deployment, TLS/gateway, PII encryption, backup/PITR/restore, metrics/tracing/load test | Chưa nghiệm thu |

Production từ chối development OTP và sandbox payment, và từ chối khởi động nếu thiếu bất kỳ khóa nào của cổng đã chọn. Trước khi nhận tiền thật cần chạy `npm run test:live`, một giao dịch sandbox của cổng, quản lý secret và checklist vận hành/bảo mật.

## Migration và vận hành

Chạy migrate trước khi khởi động. Migration đã áp dụng không được sửa; thêm file đánh số tiếp theo. Runner dùng advisory lock và kiểm tra checksum. Không cung cấp destructive rollback tự động: dùng forward migration tương thích ngược, kiểm tra backup/restore trước thay đổi production. Không xóa booking/payment/audit để reset demo.

Outbox pending được retry mỗi 5 giây. BullMQ failed job được giữ lại để kiểm tra/retry, không tự xóa. PostgreSQL là nguồn dữ liệu chuẩn; Redis AOF không thay thế backup database. Worker/realtime chưa có readiness endpoint riêng hay dashboard; đây là việc còn lại trước triển khai vận hành. File media chung ở `UPLOADED` **không được tự coi là CLEAN**; chỉ ảnh sân được decode/re-encode mới có thể chuyển `CLEAN`.

Tham chiếu kỹ thuật: [PostgreSQL range/exclusion](https://www.postgresql.org/docs/16/rangetypes.html), [Nest validation](https://docs.nestjs.com/techniques/validation), [Nest raw body](https://docs.nestjs.com/faq/raw-body), [BullMQ job IDs](https://docs.bullmq.io/guide/jobs/job-ids).
