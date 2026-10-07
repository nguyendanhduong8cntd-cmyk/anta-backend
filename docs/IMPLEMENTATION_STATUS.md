# Trạng thái backend — 07/10/2026

Backend là dịch vụ clone độc lập, **không phải backend Alobo gốc**. Android chưa gọi API này. OpenAPI được xuất tại [openapi.json](openapi.json). Các flow production có tiền/thông tin cá nhân vẫn cần tích hợp và nghiệm thu trước khi bật.

Đang có thêm bản chuyển đổi Python/FastAPI chạy song song cổng 8000: health, catalog/content, JWT phiên hiện có, hồ sơ/logout, favorites, ảnh sân R2 và runner migration chung checksum. Chưa port OTP/login/refresh, booking/payment, membership/academy/social/commerce/chat/admin, worker/realtime; bản Python chưa đủ parity để thay NestJS. Xem [python_backend/README.md](../python_backend/README.md).

Bản FastAPI đã qua 6 test Python (bao gồm catalog với PostgreSQL/Redis thật, hồ sơ/logout với JWT và kiểm tra chữ ký URL R2 bằng khóa giả); migration runner Python kiểm tra database hiện tại không có migration mới. Container FastAPI chạy trên `127.0.0.1:8000` và readiness/catalog đã được kiểm tra; NestJS cũ vẫn healthy trên cổng 3000. Đây là triển khai local, chưa phải production. Chưa kiểm thử R2 bằng credentials thật.

## Bổ sung 07/10/2026

- **Thanh toán thật:** adapter PayOS (tạo link có chữ ký, webhook HMAC-SHA256) và VNPay (URL thanh toán, IPN theo RspCode, refund API, HMAC-SHA512). Một luồng `settle` chung cho mọi cổng. Intent có `order_code` riêng, `checkoutUrl`, `qrCode`.
- **OTP thật:** `OTP_DELIVERY=provider` gửi email qua SMTP, SMS qua Twilio; mã gửi lỗi bị hủy ngay.
- **Hoàn tiền:** bảng `payment.refunds`, chính sách theo thời gian cho booking/order/lớp học, sandbox hoàn tức thì, VNPay do worker gọi, PayOS vào hàng chờ thủ công. Khoản đến muộn (`NEEDS_REVIEW`) do admin hoàn.
- **Gói thành viên, lớp học, vé có phí:** giữ chỗ `PENDING_PAYMENT` 15 phút, kích hoạt khi có thông báo đã ký, worker giải phóng khi hết hạn.
- **Chat E2E (phía server):** đăng ký key bundle theo thiết bị, cấp one-time prekey dùng một lần, hội thoại `E2E` chỉ nhận envelope ciphertext và từ chối plaintext.
- **Xóa tài khoản:** worker xóa/ẩn danh dữ liệu cá nhân sau 30 ngày, giữ chứng từ tài chính.
- **Portal admin** tại `/admin` cùng các API `/admin/stats|users|branches|bookings|payment-intents|refunds|deletion-requests`.
- **Test live** cho R2, Firebase, SMTP, Twilio: `npm run test:live`.

Đã kiểm chứng: 17 unit test và 30 integration test đạt trên PostgreSQL/Redis thật; PayOS được test qua một HTTP server giả lập, VNPay qua chữ ký tự tính. **Chưa kiểm chứng:** bất kỳ lời gọi nào tới PayOS, VNPay, SMTP, Twilio, R2, Firebase thật (5 test live đều bị bỏ qua vì thiếu khóa); portal chưa được mở thử trên trình duyệt; client mã hóa E2E trên Android chưa có.

## Đã triển khai

- Nền tảng NestJS API + worker + realtime, PostgreSQL/PostGIS, Redis/BullMQ, migration có checksum, idempotency, outbox, JWT/refresh rotation, request ID và structured logs không ghi body/token/PII.
- Catalog/search/availability/booking/hold/cancel, booking series hằng tuần tạo nguyên tử (mỗi tuần trả riêng), payment sandbox có HMAC webhook, dedupe và `NEEDS_REVIEW` cho tiền đến muộn. Booking có participant, add-on chỉ trước payment intent, review sau khi hoàn tất.
- Membership miễn phí/credit usage, academy center/course/class/session/enrollment/attendance, social event/ticket QR/team/invitation/match result, commerce order/voucher quota và sandbox order payment.
- Chat plaintext có invitation/accept, message sequence và idempotency, read cursor, pin/delete, Socket.IO event.
- Role `admin`/`support`/`branch_owner`/`branch_staff`/`coach`; API quản trị grant/revoke và audit. Không có default admin; bootstrap bằng quy trình vận hành riêng.
- Google/Firebase ID-token verifier và explicit linked-account flow đã viết; thiếu credentials để test thực tế. Không tự động link theo email.
- Yêu cầu xóa tài khoản cần xác thực lại password, lập request, khóa login và thu hồi mọi session/device.
- Cloudflare R2 private bucket cho ảnh sân: presigned PUT, HEAD/GET, decode và re-encode WebP trước khi chuyển `CLEAN`, signed GET 10 phút trong catalog branch/yard, role branch_owner/admin. Chưa có S3 key/bucket live để kiểm thử với R2 thật. Media chung `UPLOADED` không public.

## Đã kiểm chứng

- TypeScript build/typecheck và 17 unit tests đạt, gồm kiểm tra ảnh raster được xử lý lại và từ chối ảnh giả mạo.
- Integration trên PostgreSQL/Redis thật: 30 bài đạt; kiểm tra race capacity, membership credit/QR one-time, voucher quota/paid order, chat membership/sequence, booking add-on/review, weekly series, match result, RBAC, session revoke và phân quyền/ký URL ảnh sân bằng khóa giả. PUT/HEAD/GET với R2 thật chưa kiểm thử.
- OpenAPI sinh từ controller/DTO, validator parser và các schema phản hồi cốt lõi. Chạy `npm.cmd run openapi` sau khi thay đổi controller.
- `npm audit --omit=dev` tại thời điểm cài dependency báo 0 vulnerabilities, không thay thế security review.

## Chưa hoàn tất / không bật production

| Phạm vi | Việc còn lại |
|---|---|
| Android | Generate client từ OpenAPI, binding data, auth refresh/reconnect, test UI–API |
| OTP và payment thực | Khóa merchant/SMTP/Twilio thật, chạy giao dịch sandbox của từng cổng, biên lai, đối soát định kỳ, hủy vé/gói đã mua |
| Social/Firebase | Credential/project thật, emulator/provider integration test, account recovery và policy gộp tài khoản |
| Account deletion | Chính sách lưu trữ pháp lý, export dữ liệu, xử lý backup |
| Booking/social | Thanh toán tự động/gộp cho series, tournament bracket/ranking, chính sách hoàn/đổi và các trạng thái phát sinh |
| Media/chat | Chạy R2 live test với khóa thật, lifecycle quarantine, malware scanner cho attachment/media chung, moderation, client Signal trên Android và thẩm định bảo mật E2E |
| Vận hành | Portal cho chủ sân, TLS/gateway, backup/PITR + restore drill, PII encryption at rest, metrics/tracing, load/chaos tests |

Sandbox payment **không thu tiền**. `mediaUpload` chung bị báo tắt; `courtImageUpload` chỉ bật khi có cấu hình R2. Production config từ chối development OTP và sandbox payment, và yêu cầu đủ khóa của cổng đã chọn.
