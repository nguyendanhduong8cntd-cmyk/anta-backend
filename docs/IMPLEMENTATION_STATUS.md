# Trạng thái triển khai — 28/09/2026

Đợt này triển khai nền tảng + consumer booking MVP, không coi là hoàn tất toàn bộ kiến trúc. Chi tiết contract, cách chạy và phần chưa triển khai ở [README](../README.md).

## Kết quả kiểm chứng

- TypeScript build và typecheck: thành công.
- Unit test: 9/9 pass.
- Integration test: 11/11 pass, PostgreSQL 16/PostGIS và Redis thật, database `_test`, không dùng in-memory giả cho nghiệp vụ.
- OpenAPI sinh ra từ controller/DTO + response schemas; `SwaggerParser.validate` pass. Bản xuất ở [openapi.json](openapi.json).
- Dependency audit: `npm audit --omit=dev` báo 0 vulnerabilities tại thời điểm chạy; không thay thế kiểm toán bảo mật.
- Docker multi-stage image build thành công; runtime user không phải root.
- Local containers đã chạy: API, worker, realtime, PostgreSQL và Redis. API readiness xác nhận database/Redis `ok`; realtime liveness trả `ok`. Port API 3000 và realtime 3001 chỉ publish localhost.
- CI workflow có sẵn nhưng chưa chạy trên GitHub.
- Android source/build/manifest chưa thay đổi trong đợt backend này; Android chưa gọi backend mới.

## Những invariant đã test

1. Hai tài khoản giữ cùng yard/slot đồng thời: một thành công, một HTTP 409 `SLOT_UNAVAILABLE`.
2. Database từ chối overlap kể cả khi insert bỏ qua application yard lock; hai slot sát nhau không bị chặn.
3. Retry đồng thời cùng key/payload trả cùng hold/booking/payment ID; key dùng payload khác bị từ chối.
4. Người dùng khác không đọc booking/payment/notification của owner.
5. OTP sai ghi nhận attempt thật; sau 5 lần không xác minh được. Public API không trả OTP; dev endpoint cần key.
6. Refresh xoay vòng; reuse token cũ thu hồi cả family; access token logout/rotate bị từ chối.
7. Webhook không ký bị từ chối, amount sai không confirm. Webhook replay không nhân transaction.
8. Cancel chưa paid giải phóng reservation; paid cancel bị từ chối khi chưa có refund policy.
9. Worker expire booking/reservation; late webhook đưa payment vào `NEEDS_REVIEW`, không hồi sinh booking hoặc chiếm slot thay thế.
10. Outbox qua BullMQ tạo notification idempotent; read action kiểm tra owner.
11. SSE `Last-Event-ID` và Socket.IO `auth.after` replay domain event theo user; socket token sai bị từ chối.

## Giới hạn nghiệm thu

Không có merchant/SMS/Google credentials. OTP chỉ development; payment chỉ local sandbox HMAC; FCM adapter có mã nhưng chưa kiểm thử với Firebase thật. Config production bị khóa để tránh chạy giả tích hợp.

Chưa có membership/academy/social/commerce/chat/media, admin/staff RBAC, Android network binding, provider reconciliation/refund, OpenTelemetry dashboard, load test, backup/restore/PITR, mã hóa PII at rest hay deploy production. Realtime dùng database polling, chưa chứng minh tải lớn. MinIO image tải lỗi nên object storage không được đưa vào compose đang chạy; không có media endpoint giả.

Test replay hiện xác minh đọc theo cursor, không chứng minh zero-loss cho mọi tình huống mất mạng/crash/load. FCM là at-least-once; client phải dedupe event. Thử nghiệm OTP throttling ban đầu đã phát hiện bộ test vượt quota IP; fixture được tách và tái dùng account, không nới policy bảo mật.
