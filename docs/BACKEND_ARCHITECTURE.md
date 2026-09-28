# Kiến trúc backend cần triển khai cho Alobo clone

## 1. Kết luận kiến trúc

Không nên dựng backend này như một CRUD đơn giản. APK gốc cho thấy sản phẩm là một nền tảng đặt sân thể thao đa chi nhánh, có booking thời gian thực, membership, học viện, sự kiện xã hội, đội/ghép trận, dịch vụ bán thêm, nhiều cổng thanh toán, thông báo và chat.

Kiến trúc phù hợp cho giai đoạn clone là:

- Một **modular monolith** làm nguồn dữ liệu chính cho identity, catalog, booking, membership, academy, social và sales.
- Một tiến trình **realtime gateway** riêng cho Socket.IO/chat và SSE trạng thái thanh toán.
- Một tiến trình **worker** riêng cho webhook, FCM, email, hết hạn giữ chỗ, đồng bộ media và các tác vụ nền.
- PostgreSQL + PostGIS là nguồn dữ liệu chuẩn; Redis dùng cho cache, distributed lock, idempotency và hàng đợi; object storage dùng cho ảnh, audio, hóa đơn và QR.
- Tất cả API public đi qua một gateway duy nhất. Các module có thể tách thành microservice sau khi có tải thật, không tách sớm.

Stack tham chiếu để triển khai nhanh: **NestJS/TypeScript + PostgreSQL 16/PostGIS + Redis + BullMQ + Socket.IO + S3-compatible storage + Firebase Admin SDK**. Có thể thay NestJS bằng Spring Boot mà không đổi ranh giới module hay contract trong tài liệu này.

## 2. Bằng chứng đã xác nhận từ APK gốc

Nguồn phân tích là APK `com.alobo.sportUser` phiên bản `2.10.1` (`versionCode 2603`), manifest, Flutter assets, AOT binary `libapp.so` và các màn đã capture. Đây là bằng chứng tĩnh; không có source backend gốc.

### 2.1 Kết nối và cấu hình

Binary có các cấu hình endpoint tách biệt:

- `endPointApi` và `newEndPointApi`: nghiệp vụ lõi/legacy và API mới.
- `paymentEndPointApi`: thanh toán.
- `eduEndPointApi`: academy, coach, course, class và enrollment.
- `notificationEndPoint`: notification API.
- `chatEndPointApi`: chat.
- `sseEndPointApi` và `sseEduEndPointApi`: stream trạng thái membership/enrollment.

Giá trị base URL thật không nằm cố định trong APK; app có Firebase Remote Config và nhận endpoint/feature flag lúc chạy. Vì vậy các host deep link như `datlich.alobo.vn` không được coi là API host nếu chưa có capture mạng xác nhận.

Client dùng Dio/HTTP, `Authorization: Bearer`, `access_token`, `refresh_token` và `persistent_token`. Có Firebase Auth/Google Sign-In, nhưng vẫn có account API riêng, OTP và refresh token riêng.

### 2.2 Các miền nghiệp vụ

Các repository/service/model trong AOT xác nhận các miền sau:

- Account, OTP, login xã hội, linked account, profile và personalization.
- Branch/shop, sport type, yard, bảng giá, dịch vụ, tìm kiếm theo vùng/vị trí và favorite.
- Booking một lần, booking định kỳ, multi-date, anonymous booking, khóa sân, participant, hủy và đánh giá.
- Social event/match, ticket, team, invitation, friends và ghép trận.
- Membership, contract, debt/usage, ticket theo membership và lịch sử sử dụng.
- Academy: center, coach, course, class, student, enrollment, session, attendance và tuition plan.
- Sales/request order, service order, voucher, hot deal, news feed và mini game.
- Payment: PayOS, PayPal, VNPay, VietQR, BIDV và VietinBank; có upload biên lai và payment transaction.
- Notification API, FCM token, notification setting theo chi nhánh.
- Chat realtime dùng Socket.IO, local SQLite cache, attachment upload nhiều bước, quota, pinned message, role/member và crypto handshake.

Một số route được xác nhận trực tiếp gồm `/api/v1/user/booking/`, `/api/v1/user/request-order`, `/api/v1/user/sse/memberships/`, `/api/v1/user/sse/enrollments/`, `/user/booking/branch-events`, `/user/tickets`, `/user/tickets/buy-with-membership`, cùng nhóm chat `/api/v1/crypto/handshake`, `/api/v1/attachment/upload/*`, `/conversation/*`, `/message/*`.

### 2.3 SDK và tích hợp nền tảng

- Firebase Analytics, Crashlytics, Messaging, Remote Config, Auth, Firestore và Storage.
- MapLibre/Goong và điều hướng sang ứng dụng bản đồ ngoài.
- ML Kit barcode scanner cho QR.
- Socket.IO cho chat và SSE cho cập nhật trạng thái dài hạn.
- Deep link HTTPS/custom scheme cho booking, branch, event và invitation.

Các route nêu ở trên là dấu vết của app gốc. Contract ở mục 6 là contract chuẩn hóa đề xuất cho backend clone, không phải khẳng định từng URL của hệ thống gốc.

## 3. Sơ đồ tổng thể

```mermaid
flowchart LR
    A[Android client] --> G[CDN / WAF / API Gateway]
    G --> C[Core API modular monolith]
    G --> R[Realtime Gateway]
    G --> M[Media service]

    C --> P[(PostgreSQL + PostGIS)]
    C --> X[(Redis)]
    C --> Q[Job queue]
    R --> X
    R --> P
    M --> O[(S3-compatible object storage)]

    Q --> W[Background workers]
    W --> F[Firebase FCM]
    W --> E[Email provider]
    W --> Y[Payment providers]
    Y --> G

    C --> RC[Remote config / feature flags]
```

Nguyên tắc sở hữu dữ liệu: client không gọi trực tiếp database hoặc cổng thanh toán để quyết định trạng thái nghiệp vụ. Mọi thay đổi booking/payment phải đi qua Core API; webhook của payment provider là nguồn xác nhận cuối cùng.

## 4. Ranh giới module

| Module | Trách nhiệm chính |
|---|---|
| Identity | Đăng ký, login email/phone, OTP, social login, refresh/revoke token, device session, linked account, xóa tài khoản |
| User/Profile | Hồ sơ, thể chất, môn yêu thích, cấp độ, vị trí ưa thích, privacy và personalization |
| Catalog/Geo | Sport, shop, branch, yard, bảng giá, giờ mở cửa, dịch vụ, ảnh, rule, tìm kiếm PostGIS |
| Availability | Sinh slot, kiểm tra lịch bận, giữ chỗ có TTL, giá theo ngày/giờ, khóa cạnh tranh |
| Booking | One-time/recurring/social booking, participant, lifecycle, cancel, pass yard, review |
| Social/Team | Event, matching, ticket, team, friend, invitation và QR join |
| Membership | Plan, contract, usage, debt, membership ticket, discount và renewal |
| Academy | Center, coach, course, class, session, enrollment, tuition, student và attendance |
| Sales/Service | Request order, service order, add-on, order lifecycle và shop fulfillment |
| Voucher/Pricing | Điều kiện áp dụng, quota, rank, time range, yard type, quote và discount |
| Payment | Payment intent, provider adapter, transaction, QR, receipt, refund và webhook |
| Notification | FCM device, inbox, preference, branch mute/block và campaign |
| Chat | Conversation, member/role, message, attachment, presence, unread, moderation và E2E handshake |
| Content | Banner, hot deal, news feed, guide/what's new, policy/term và mini game |
| Audit/Analytics | Click/business event, audit trail, reconciliation và operational report |

Mỗi module có controller, application service, domain model và repository riêng. Không được truy cập bảng của module khác trực tiếp từ controller; giao tiếp nội bộ qua service interface hoặc domain event.

## 5. Mô hình dữ liệu cốt lõi

Các bảng nên chia schema theo module nhưng dùng chung một PostgreSQL trong giai đoạn đầu.

| Nhóm | Bảng chính |
|---|---|
| Identity | `users`, `user_identities`, `otp_challenges`, `refresh_sessions`, `devices`, `linked_accounts` |
| Catalog | `sports`, `shops`, `branches`, `yards`, `yard_sport_types`, `opening_hours`, `price_rules`, `services`, `branch_media`, `branch_rules` |
| Geo | `provinces`, `wards`, `branch_locations`, `user_favorite_locations`; cột vị trí dùng `geography(Point,4326)` |
| Booking | `booking_holds`, `bookings`, `booking_occurrences`, `booking_slots`, `booking_participants`, `booking_services`, `booking_status_history`, `reviews` |
| Social | `events`, `matches`, `tickets`, `ticket_members`, `teams`, `team_members`, `invitations`, `friendships` |
| Membership | `membership_plans`, `membership_contracts`, `membership_usages`, `membership_usage_logs`, `membership_tickets` |
| Academy | `centers`, `coaches`, `courses`, `classes`, `class_sessions`, `students`, `enrollments`, `attendance`, `tuition_plans` |
| Commerce | `orders`, `order_items`, `service_requests`, `vouchers`, `voucher_conditions`, `voucher_redemptions` |
| Payment | `payment_intents`, `payment_transactions`, `payment_attempts`, `payment_receipts`, `refunds`, `provider_webhook_events` |
| Notification | `notifications`, `notification_preferences`, `campaigns`, `outbox_events` |
| Chat | `conversations`, `conversation_members`, `messages`, `message_attachments`, `pinned_messages`, `conversation_tags`, `chat_key_sessions` |

Quy ước bắt buộc:

- ID dùng UUID/ULID; tiền lưu integer minor unit và kèm currency, không dùng float.
- Thời gian lưu UTC, branch giữ IANA timezone; API trả ISO-8601 có offset.
- Bảng nghiệp vụ có `created_at`, `updated_at`, `version`; dữ liệu cần audit có `created_by` và status history.
- Soft delete chỉ dùng cho nội dung cần khôi phục. Booking/payment/audit không xóa vật lý.
- Mọi bảng đa tenant có `shop_id` hoặc `branch_id` và index tenant tương ứng.

## 6. Contract API cần triển khai

Gateway public dùng `/api/v1`; API mới không tương thích mới tăng `/api/v2`. Response thống nhất:

```json
{
  "data": {},
  "meta": { "requestId": "01...", "page": 1, "pageSize": 20 },
  "error": null
}
```

Nhóm endpoint tối thiểu:

### Identity và user

- `POST /api/v1/public/auth/login`
- `POST /api/v1/public/auth/social`
- `POST /api/v1/public/auth/otp/send`
- `POST /api/v1/public/auth/otp/verify`
- `POST /api/v1/public/auth/refresh`
- `POST /api/v1/auth/logout`
- `GET|PATCH /api/v1/users/me`
- `POST|DELETE /api/v1/users/me/devices/{deviceId}`
- `GET|POST|PATCH|DELETE /api/v1/users/me/linked-accounts`
- `DELETE /api/v1/users/me` với re-auth và thời gian chờ xóa.

### Catalog, map và availability

- `GET /api/v1/public/sports`
- `GET /api/v1/public/branches?lat=&lng=&radius=&sportId=&date=`
- `GET /api/v1/public/branches/{branchId}`
- `GET /api/v1/public/branches/{branchId}/services`
- `GET /api/v1/public/branches/{branchId}/availability?from=&to=&sportId=`
- `POST /api/v1/booking-holds` và `DELETE /api/v1/booking-holds/{holdId}`.

### Booking

- `POST /api/v1/bookings` với header `Idempotency-Key`.
- `GET /api/v1/users/me/bookings` và `GET /api/v1/bookings/{bookingId}`.
- `POST /api/v1/bookings/{bookingId}/cancel`.
- `POST|DELETE /api/v1/bookings/{bookingId}/participants`.
- `POST /api/v1/bookings/{bookingId}/services`.
- `POST /api/v1/bookings/{bookingId}/reviews`.
- `GET /api/v1/branches/{branchId}/events`.

### Membership, academy và social

- CRUD đọc/đăng ký cho `membership-plans`, `membership-contracts`, `membership-usages`.
- `GET /api/v1/academy/centers|coaches|courses|classes` và endpoint detail.
- `POST /api/v1/academy/classes/{classId}/enrollments`.
- `GET /api/v1/users/me/class-sessions`.
- CRUD có kiểm soát cho `events`, `tickets`, `teams`, `invitations` và `matches`.
- `POST /api/v1/tickets/{ticketId}/buy-with-membership`.

### Order, voucher và payment

- `POST /api/v1/orders`, `GET /api/v1/orders/{orderId}`, `POST /api/v1/orders/{orderId}/cancel`.
- `POST /api/v1/quotes` trả subtotal, discount, deposit, fee và expiry.
- `POST /api/v1/vouchers/validate`.
- `POST /api/v1/payment-intents`.
- `GET /api/v1/payment-intents/{paymentIntentId}`.
- `POST /api/v1/payment-intents/{id}/receipts`.
- `POST /api/v1/webhooks/payments/{provider}`; endpoint này xác thực chữ ký, dedupe event và không dùng auth của user.

### Notification, media và chat

- `POST /api/v1/devices/fcm-token`.
- `GET /api/v1/notifications`, `POST /api/v1/notifications/{id}/read`.
- `GET|PATCH /api/v1/notification-preferences`.
- `POST /api/v1/media/presign` và `POST /api/v1/media/complete`.
- Chat giữ contract `/api/v1/crypto/handshake`, `/api/v1/attachment/upload/init|chunk|complete`, `/conversation/*`, `/message/*` để gần với app gốc.

OpenAPI phải là nguồn contract chính. Android client được generate DTO/API interface từ OpenAPI; không sao chép model thủ công ở nhiều nơi.

## 7. Luồng booking và thanh toán

```mermaid
sequenceDiagram
    participant U as Android
    participant B as Booking API
    participant R as Redis
    participant D as PostgreSQL
    participant P as Payment provider
    participant W as Worker

    U->>B: POST /booking-holds (yard, slots)
    B->>D: Transaction + kiểm tra overlap
    B->>R: Lock/TTL hold
    B-->>U: holdId, quote, expiresAt
    U->>B: POST /bookings + Idempotency-Key
    B->>D: Tạo booking PENDING_PAYMENT
    U->>B: POST /payment-intents
    B->>P: Tạo link/QR thanh toán
    P-->>U: Redirect/deep link
    P->>B: Signed webhook
    B->>D: Dedupe + confirm transaction/booking
    B->>W: booking.confirmed event
    W-->>U: FCM và SSE update
```

Các invariant bắt buộc:

- Database phải chặn overlap slot bằng transaction và unique/exclusion constraint; Redis lock chỉ là lớp tối ưu, không phải bảo đảm cuối.
- Hold có TTL ngắn, mặc định 5 phút. Worker giải phóng hold và booking chưa thanh toán quá hạn.
- `Idempotency-Key` áp dụng cho booking, order, payment intent, cancel và refund.
- Client redirect thành công không được tự chuyển booking sang paid; chỉ signed webhook hoặc đối soát provider được phép xác nhận.
- Booking định kỳ tạo occurrence riêng để hủy/đổi từng buổi và phát hiện xung đột chính xác.
- Mỗi thay đổi status phải đi qua state machine và ghi `booking_status_history`.

## 8. Realtime, notification và offline

- Socket.IO dùng cho chat, typing/presence, unread count và message acknowledgement. JWT cho handshake; reconnect dùng cursor/message sequence thay vì dựa vào thời gian thiết bị.
- SSE dùng cho trạng thái payment membership/enrollment để bám hành vi app gốc. Endpoint hỗ trợ `Last-Event-ID`, heartbeat, retry backoff và resume.
- FCM dùng cho trạng thái cần đến khi app background: booking confirmed/cancelled, payment, invitation, class reminder và chat notification.
- Android cache dữ liệu đọc bằng Room/SQLite. Queue ghi offline chỉ dùng cho thao tác idempotent như mark-read/favorite; không queue ngầm booking hoặc payment.
- Outbox pattern bảo đảm transaction nghiệp vụ và event gửi worker không bị lệch trạng thái.

## 9. Bảo mật

- Access token 10-15 phút; refresh token xoay vòng, hash trong database và revoke theo device/session.
- OTP có TTL, giới hạn lần thử, cooldown, rate limit theo account/IP/device và chống user enumeration.
- RBAC theo `user`, `branch_staff`, `branch_owner`, `coach`, `support`, `admin`; mọi truy vấn phải kiểm tra tenant ownership.
- Webhook payment xác minh signature/timestamp, lưu raw event hash để dedupe và chạy reconciliation định kỳ.
- Upload dùng presigned URL, allowlist MIME/size, quét malware và tách bucket public/private.
- Mã hóa PII và payment receipt khi lưu; secret nằm trong secret manager, không nằm trong APK hay Git.
- Chat key handshake và key rotation phải được threat-model riêng; không tự thiết kế mật mã mới.
- Rate limit gateway, validation schema, CORS/deep-link allowlist, audit log cho thao tác admin và account deletion.

## 10. Logging và observability

Android tiếp tục dùng `Logger.kt` hiện tại:

- `SCREEN_SHOW` cho mỗi màn.
- `DIALOG_SHOW` cho popup/dialog/bottom sheet.
- `CLICK` cho mọi vùng tương tác.
- `CURL`, `REQUEST`, `RESPONSE` cho mọi request backend.

Log curl/request/response chỉ bật ở debug hoặc môi trường test và phải che `Authorization`, cookie, refresh token, OTP, password, email/phone nhạy cảm và signed URL. Production chỉ log method, route template, status, latency, request ID và kích thước payload.

Backend dùng JSON structured log với `requestId`, `userId` đã hash, `tenantId`, `bookingId/orderId/paymentId`, latency và error code. Gateway nhận hoặc sinh `X-Request-Id` rồi truyền qua Core, realtime, worker và webhook. Metric tối thiểu: API latency/error rate, lock conflict, booking conversion, hold expiry, webhook delay/failure, queue lag, SSE/Socket connections và FCM failure.

Tracing dùng OpenTelemetry; dashboard/alert dùng Prometheus + Grafana, log dùng Loki/ELK, exception server dùng Sentry hoặc tương đương. Client giữ Firebase Crashlytics/Analytics/Performance bật; không thêm các manifest metadata tắt collection đã bị cấm trong yêu cầu clone.

## 11. Cấu trúc source đề xuất

```text
backend/
├─ apps/
│  ├─ api/                 # REST gateway + modular monolith
│  ├─ realtime/            # Socket.IO + SSE
│  └─ worker/              # queue consumers, FCM, webhook reconciliation
├─ packages/
│  ├─ contracts/           # OpenAPI schemas, event schemas, error codes
│  ├─ auth/
│  ├─ observability/
│  └─ testkit/
├─ modules/
│  ├─ identity/
│  ├─ catalog/
│  ├─ booking/
│  ├─ membership/
│  ├─ academy/
│  ├─ social/
│  ├─ commerce/
│  ├─ payment/
│  ├─ notification/
│  ├─ chat/
│  └─ content/
├─ migrations/
├─ infra/                  # Docker, Terraform/K8s manifests, dashboards
└─ docs/                   # ADR, OpenAPI, event catalogue, runbooks
```

Mỗi module có `domain`, `application`, `infrastructure`, `http` và test. Không tạo shared package chứa mọi thứ; chỉ chia sẻ contract, auth primitives và observability.

## 12. Môi trường và triển khai

- `local`: Docker Compose với PostgreSQL/PostGIS, Redis, MinIO và mock payment/FCM.
- `dev`, `staging`, `prod`: database, bucket, Firebase project, signing key và payment merchant tách biệt hoàn toàn.
- CI chạy lint, unit test, integration test bằng database thật, contract test, migration dry-run, SAST/dependency scan và build image bất biến.
- CD chạy migration backward-compatible trước, rolling/blue-green deploy sau; có health/readiness check và rollback image.
- Backup PostgreSQL PITR, versioning object storage, Redis không là nguồn dữ liệu chuẩn. Kiểm thử restore định kỳ.

## 13. Lộ trình thực hiện

### Phase 0 - Contract và nền tảng

1. Chốt state machine booking/order/payment và error code.
2. Dựng monorepo, CI, Docker Compose, migration, auth skeleton, request ID và log redaction.
3. Xuất OpenAPI, tạo Android networking layer và môi trường mock.

### Phase 1 - MVP bám các màn clone hiện tại

1. Auth/OTP/social login, profile và FCM device.
2. Sport/branch/yard/map/search/detail.
3. Availability, hold, booking một lần, booking history và cancel.
4. Quote, payment intent, một provider sandbox, webhook và FCM.
5. Terms/version/content từ backend hoặc Remote Config.

### Phase 2 - Parity nghiệp vụ

1. Booking định kỳ, social event/match, ticket, team/invitation và QR.
2. Membership/voucher/rank/favorite.
3. Service order, receipt upload và các provider thanh toán còn lại.
4. Academy/course/class/enrollment/session/attendance và SSE payment.

### Phase 3 - Realtime và vận hành đầy đủ

1. Chat Socket.IO, attachment pipeline, moderation, unread/pin/search và crypto handshake.
2. Admin/owner portal, reconciliation, reporting và audit export.
3. Load test booking contention, DR drill, fraud/rate-limit tuning và observability SLO.

## 14. Điều kiện nghiệm thu backend

- Hai client cạnh tranh cùng yard/slot không thể cùng được confirm.
- Retry cùng `Idempotency-Key` không tạo booking/payment/order thứ hai.
- Webhook trùng hoặc đến sai thứ tự vẫn cho một trạng thái cuối đúng.
- SSE/Socket reconnect không mất event/message và không gửi trùng ở UI.
- Log có correlation end-to-end nhưng không lộ token/OTP/password/PII.
- Search theo bán kính dùng PostGIS và có index plan được kiểm tra.
- Migration có rollback/forward strategy; restore backup được kiểm chứng.
- Client log đủ screen/dialog/click/network theo yêu cầu và Firebase collection không bị tắt.

## 15. Điểm chưa thể xác nhận từ APK

- Host API production thực tế, vì được cấp qua Remote Config.
- Payload/schema chính xác của từng endpoint và rule tính giá phía server.
- Signature scheme và merchant credential của từng payment provider.
- Chính sách refund/cancel, TTL giữ chỗ và timezone theo từng branch.
- Chat có mã hóa đầu-cuối hoàn chỉnh hay chỉ mã hóa transport/session.

Các điểm này phải được chốt bằng capture request/response ở môi trường được phép hoặc bằng tài liệu backend chính chủ trước khi coding contract production. Không nên đoán credential, bypass certificate pinning hay nhúng secret lấy từ APK.

Nếu sau này Settings có Feedback, app mở email tới `support@your-domain.com`; không cần tạo feedback API trừ khi sản phẩm bổ sung quản lý ticket trong admin portal.
