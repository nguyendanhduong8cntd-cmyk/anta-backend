# Hướng dẫn thực hiện phần Chủ sân và Admin

Tài liệu này dành cho ba thành viên mới của nhóm Anta. Đọc xong, bạn chạy được dự án trên máy, hiểu cách code đang được viết, và biết từng bước phải làm cho mảng của mình.

Cách đọc:

- Ai cũng đọc mục 1 đến 6 và mục 11, 12.
- Thành viên A đọc thêm mục 8. Thành viên B đọc mục 9. Thành viên C đọc mục 10.
- Mục 7 là phần nền do trưởng nhóm làm trong hai ngày đầu. Ba bạn cần biết nó có gì vì mọi việc khác dựa trên nó.

Mọi đường dẫn file trong tài liệu tính từ thư mục gốc của repo `anta-backend`.

## Mục lục

1. [Chạy dự án trên máy](#1-chạy-dự-án-trên-máy)
2. [Một yêu cầu đi qua những đâu](#2-một-yêu-cầu-đi-qua-những-đâu)
3. [Công thức thêm một API](#3-công-thức-thêm-một-api)
4. [Công thức thêm migration](#4-công-thức-thêm-migration)
5. [Công thức viết test tích hợp](#5-công-thức-viết-test-tích-hợp)
6. [Công thức thêm màn hình web](#6-công-thức-thêm-màn-hình-web)
7. [Phần nền của trưởng nhóm](#7-phần-nền-của-trưởng-nhóm)
8. [Việc của A: sân, dịch vụ, thu chi, thống kê](#8-việc-của-a-sân-dịch-vụ-thu-chi-thống-kê)
9. [Việc của B: lịch sân, đơn đặt, hủy đơn](#9-việc-của-b-lịch-sân-đơn-đặt-hủy-đơn)
10. [Việc của C: admin toàn hệ thống](#10-việc-của-c-admin-toàn-hệ-thống)
11. [Những bẫy đã biết trong dự án](#11-những-bẫy-đã-biết-trong-dự-án)
12. [Trước khi mở pull request](#12-trước-khi-mở-pull-request)
13. [Kịch bản demo cuối](#13-kịch-bản-demo-cuối)

## 1. Chạy dự án trên máy

### 1.1. Cài đặt một lần

Cần Git, Node.js 24 LTS, Docker Desktop và VS Code. Mở PowerShell rồi chạy lần lượt:

```powershell
git clone https://github.com/nguyendanhduong8cntd-cmyk/anta-backend.git
cd anta-backend
npm.cmd ci
npm.cmd run setup:local
docker compose -f infra/compose.yaml up -d postgres redis
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:import-venues -- data/venues/hcm.json
npm.cmd run start:api
```

Mỗi lệnh làm gì:

| Lệnh | Tác dụng |
|---|---|
| `npm.cmd ci` | Tải thư viện |
| `setup:local` | Build code và tạo file `.env` từ `.env.example` nếu chưa có |
| `docker compose ... up -d postgres redis` | Chạy PostgreSQL ở cổng 55432 và Redis ở cổng 56379 |
| `db:migrate` | Tạo cấu trúc database từ thư mục `migrations` |
| `db:seed` | Tạo một cơ sở demo, mã `30000000-0000-4000-8000-000000000001` |
| `db:import-venues` | Nạp 54 cơ sở thật vào database trên máy |
| `start:api` | Chạy API ở `http://127.0.0.1:3000` |

Kiểm tra:

- `http://127.0.0.1:3000/docs` hiện danh sách API, bấm thử được từng cái.
- `http://127.0.0.1:3000/admin/` hiện trang đăng nhập admin.
- `http://127.0.0.1:3000/api/v1/public/branches` trả về danh sách cơ sở.

### 1.2. Vòng lặp mỗi lần sửa code

`start:api` chạy code đã build trong thư mục `dist`, không chạy thẳng file `.ts`. Vì vậy:

```powershell
npm.cmd run build        # sau mỗi lần sửa file .ts
npm.cmd run start:api    # chạy lại API
```

File trong `apps/admin/public` và `apps/owner/public` là file tĩnh. Sửa xong chỉ cần tải lại trang, không cần build.

Chạy test:

```powershell
npm.cmd test                      # test đơn vị, không cần database
npm.cmd run test:integration      # test gọi API thật, cần postgres và redis đang chạy
```

Test tích hợp dùng database riêng tên `anta_test`, không đụng tới dữ liệu bạn đang thử tay.

### 1.3. Tạo tài khoản thử

Hệ thống không có tài khoản mặc định. Sau khi trưởng nhóm xong phần nền, chỉ cần chạy `npm.cmd run demo:accounts`. Trước lúc đó, tạo tay như sau.

Bước 1. Mở `.env`, đặt hai dòng rồi chạy lại API:

```
DEV_OTP_ENABLED=true
DEV_ADMIN_KEY=mot-chuoi-bat-ky-dai-it-nhat-32-ky-tu
```

Bước 2. Đăng ký tài khoản bằng PowerShell. Đổi `$id` cho mỗi tài khoản.

```powershell
$api = "http://127.0.0.1:3000/api/v1"
$key = "mot-chuoi-bat-ky-dai-it-nhat-32-ky-tu"
$id  = "chusan@example.com"
$json = "application/json"

$sent = Invoke-RestMethod "$api/public/auth/otp/send" -Method Post -ContentType $json -Body (@{ identifier = $id; purpose = "register" } | ConvertTo-Json)
$code = (Invoke-RestMethod "$api/dev/otp/$($sent.data.challengeId)" -Headers @{ "X-Dev-Key" = $key }).data.code
$ok   = Invoke-RestMethod "$api/public/auth/otp/verify" -Method Post -ContentType $json -Body (@{ challengeId = $sent.data.challengeId; code = $code } | ConvertTo-Json)
$acc  = Invoke-RestMethod "$api/public/auth/register" -Method Post -ContentType $json -Body (@{ identifier = $id; password = "mat-khau-thu-2026"; displayName = "Chu san thu"; deviceId = "may-cua-toi"; verificationToken = $ok.data.verificationToken } | ConvertTo-Json)
$acc.data.user.id
```

Dòng cuối in ra mã tài khoản. Mật khẩu phải dài từ 10 ký tự. Tên hiển thị trong đoạn lệnh viết không dấu vì PowerShell gửi chữ có dấu đi sẽ bị lỗi phông.

Bước 3. Cấp quyền trong database. Thay `MA_TAI_KHOAN` bằng mã vừa in.

```powershell
# quyền admin
docker compose -f infra/compose.yaml exec postgres psql -U anta -d anta -c "INSERT INTO identity.roles(user_id,role) VALUES('MA_TAI_KHOAN','admin')"

# quyền chủ sân của cơ sở demo
docker compose -f infra/compose.yaml exec postgres psql -U anta -d anta -c "INSERT INTO identity.roles(user_id,role,branch_id) VALUES('MA_TAI_KHOAN','branch_owner','30000000-0000-4000-8000-000000000001')"
```

Chỉ làm việc này trên database ở máy mình.

## 2. Một yêu cầu đi qua những đâu

Lấy ví dụ có thật: chủ sân tạo voucher bằng `POST /api/v1/vouchers`.

1. `apps/api/bootstrap.ts` nhận yêu cầu. Ở đây gắn tiền tố `api/v1`, giới hạn 180 yêu cầu mỗi phút cho một địa chỉ, và kiểm tra dữ liệu gửi lên theo DTO.
2. `packages/auth/guard.ts` đọc token ở header `Authorization: Bearer ...`. Token sai, phiên đã thu hồi hoặc tài khoản không ở trạng thái `ACTIVE` thì trả 401. API nào không cần đăng nhập phải ghi `@Public()`.
3. `modules/commerce/controller.ts` khai báo đường dẫn, lấy người dùng bằng `@CurrentUser()` và gọi service.
4. `modules/commerce/service.ts` làm việc thật. Hàm `createVoucher` là mẫu chuẩn cho mọi API của chủ sân:

```ts
return this.db.transaction(async tx => {
  await this.access.owner(userId, dto.branchId, tx);          // kiểm tra quyền trước tiên
  const row = (await tx.query(`INSERT INTO commerce.vouchers(...) VALUES(...) RETURNING *`, [...])).rows[0];
  await this.access.audit(tx, userId, 'voucher.create', 'voucher', row.id, requestId);   // ghi nhật ký
  return row;
});
```

5. Kết quả được bọc lại thành một khuôn chung trước khi trả về:

```json
{ "data": { "...": "..." }, "meta": { "requestId": "..." }, "error": null }
```

Khi lỗi, `data` là `null` và `error` có `code` cùng `message`.

Những mảnh ghép bạn sẽ dùng lại liên tục:

| Cần gì | Dùng gì | Ở đâu |
|---|---|---|
| Truy vấn database | `this.db.query(sql, [tham số])` | `packages/database.ts` |
| Nhiều câu lệnh phải cùng thành công hoặc cùng thất bại | `this.db.transaction(async tx => { ... })` | `packages/database.ts` |
| Kiểm tra quyền admin | `await this.access.admin(userId)` | `packages/access.ts` |
| Kiểm tra quyền chủ sân của một cơ sở | `await this.access.owner(userId, branchId)` | `packages/access.ts` |
| Ghi nhật ký thao tác | `await this.access.audit(tx, userId, 'hanh.dong', 'loai', id, requestId, chiTiet)` | `packages/access.ts` |
| Báo lỗi cho người gọi | `invariant(dieuKien, 'MA_LOI', 'Thông điệp', 409)` | `packages/contracts/errors.ts` |
| Gửi thông báo cho một người dùng | `await emitEvent(tx, userId, 'booking.rejected', { bookingId }, requestId)` | `packages/events.ts` |
| Chống gửi trùng một thao tác tạo mới | `this.idem.run(userId, 'ten-thao-tac', key, dto, async tx => { ... })` | `packages/idempotency.ts` |
| Đổi trạng thái đơn đặt | `this.booking.transition(tx, row, 'CANCELLED', 'lý do', userId, requestId)` | `modules/booking/service.ts` |
| Tạo lệnh hoàn tiền | `this.refunds.request(tx, 'booking', bookingId, phanTram, 'lý do', requestId)` | `modules/payment/refunds.ts` |

`access.admin` cho qua người có vai trò `admin`. `access.owner` cho qua admin và người có vai trò `branch_owner` của đúng cơ sở đó. Người khác nhận lỗi 403.

`emitEvent` ghi một dòng vào `platform.outbox_events`. Tiến trình worker đọc bảng này và tạo thông báo trong hộp thư của người dùng. Bạn không phải làm gì thêm.

## 3. Công thức thêm một API

Ví dụ xuyên suốt: chủ sân sửa giá một sân bằng `PATCH /api/v1/owner/yards/:id`.

### Bước 1. Viết DTO

DTO mô tả dữ liệu được phép gửi lên. Trường nào không khai báo ở đây mà vẫn gửi lên thì hệ thống trả 400 ngay.

```ts
// modules/owner/venue.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class UpdateYardDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1000) @Max(100000000) hourlyPrice?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
}
```

Tham số trên đường dẫn dạng `?page=2` cần thêm `@Type(() => Number)` thì mới được đổi sang số. Xem `AdminListQuery` trong `modules/admin/dto.ts`.

### Bước 2. Viết hàm trong service

```ts
// modules/owner/venue.service.ts
async updateYard(userId: string, yardId: string, dto: UpdateYardDto, requestId: string) {
  return this.db.transaction(async tx => {
    const yard = (await tx.query('SELECT * FROM catalog.yards WHERE id=$1 FOR UPDATE', [yardId])).rows[0];
    invariant(yard, 'NOT_FOUND', 'Yard not found', 404);
    await this.access.owner(userId, yard.branch_id, tx);
    const row = (await tx.query(`UPDATE catalog.yards SET name=coalesce($2,name),hourly_price=coalesce($3,hourly_price),active=coalesce($4,active)
      WHERE id=$1 RETURNING id,branch_id,sport_id,name,hourly_price,currency,active`,
      [yardId, dto.name ?? null, dto.hourlyPrice ?? null, dto.active ?? null])).rows[0];
    await this.access.audit(tx, userId, 'yard.update', 'yard', yardId, requestId, { ...dto });
    return row;
  });
}
```

Ba điều bắt buộc trong mọi hàm ghi dữ liệu:

- Giá trị người dùng nhập luôn đi qua `$1`, `$2`. Không ghép chuỗi vào câu SQL.
- Kiểm tra quyền nằm trong cùng transaction với thao tác ghi.
- Có dòng `access.audit`.

### Bước 3. Khai báo đường dẫn trong controller

```ts
// modules/owner/venue.controller.ts
@Patch('yards/:id') updateYard(@CurrentUser() user: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  @Body() dto: UpdateYardDto, @Req() req: AuthRequest) {
  return this.venues.updateYard(user.userId, id, dto, req.requestId);
}
```

`POST` mặc định trả mã 201. Với thao tác không tạo mới, như xác nhận hay khóa, thêm `@HttpCode(200)` giống `modules/admin/controller.ts`.

### Bước 4. Đăng ký vào module

Controller và service mới phải có tên trong `modules/owner/module.ts`. Module mới phải có tên trong danh sách `imports` của `apps/api/module.ts`. Quên bước này thì API trả 404.

### Bước 5. Viết test, build, chạy

Xem mục 5. Sau đó:

```powershell
npm.cmd run build
npm.cmd run test:integration
npm.cmd run openapi
```

Lệnh `openapi` sinh lại `docs/openapi.json`. Commit file đó cùng với code.

## 4. Công thức thêm migration

Migration là file SQL trong thư mục `migrations`, chạy theo thứ tự tên file. Hiện có từ `001` đến `010`.

Số đã chia sẵn để không ai trùng ai:

| Số | Của ai | Nội dung |
|---|---|---|
| 011 | Trưởng nhóm | Trạng thái đơn mới, trạng thái cơ sở, tùy chọn tự động xác nhận |
| 012 | A | Trạng thái dịch vụ, bảng thu chi tại sân |
| 013 | B | Khung giờ khóa, yêu cầu hủy, đơn tại quầy |
| 014 | C | Để dành cho admin nếu cần |

Cần thêm file thì báo trong nhóm để lấy số tiếp theo, bắt đầu từ 015.

Quy tắc:

- Đặt tên dạng `012_owner_services_payments.sql`.
- Không bao giờ sửa một file migration đã chạy. Chương trình lưu mã kiểm tra của từng file, sửa một ký tự là lần chạy sau báo lỗi `Migration changed after applying`. Sai thì viết file mới để sửa.
- Trong lúc đang viết dở trên máy mình mà cần sửa file, xóa database thử rồi tạo lại:

```powershell
docker compose -f infra/compose.yaml down -v
docker compose -f infra/compose.yaml up -d postgres redis
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run db:import-venues -- data/venues/hcm.json
```

- Ràng buộc trạng thái viết bằng `CHECK(status IN (...))` như các bảng có sẵn.
- Bảng mới đặt trong đúng schema của mảng: `catalog`, `booking`, `payment`, `identity`, `platform`.
- Sau khi thêm migration, chạy `npm.cmd run db:migrate` rồi chạy lại toàn bộ test tích hợp.

## 5. Công thức viết test tích hợp

Mỗi mảng có một file test riêng trong `tests/integration`: `owner-venue.test.ts` của A, `owner-bookings.test.ts` của B, `admin.test.ts` của C.

Cách bắt đầu: chép phần đầu của `tests/integration/domains.test.ts`, từ dòng đầu đến hết khối `after(...)`. Phần đó đã có sẵn:

- Các dòng ép test chạy trên database `anta_test`. Giữ nguyên.
- Hàm `request(path, method, body, jwt, headers)` gọi API và trả về `status` cùng `body`.
- Hàm `account('ten')` tạo một tài khoản mới và trả về `user.id`, `accessToken`.
- Hàm `role(userId, 'branch_owner')` cấp quyền cho cơ sở thử.
- Khối `before` tạo một cơ sở, một sân và một dịch vụ riêng cho file test, có mã trong `branchId`, `yardId`, `serviceId`.

Sửa một chỗ: đổi tên trong `REDIS_KEY_PREFIX` thành tên mảng của bạn, ví dụ `anta-owner-venue-${runId}:`.

Hàm `role` luôn gắn quyền với cơ sở thử, nên chỉ dùng cho `branch_owner` và `branch_staff`. Quyền admin không gắn với cơ sở nào, cấp bằng một câu riêng như test đang có:

```ts
await pool.query("INSERT INTO identity.roles(user_id,role) VALUES($1,'admin')", [admin.user.id]);
```

Một test mẫu cho API ở mục 3:

```ts
test('an owner changes a yard price and another account cannot', async () => {
  const owner = await account('owner'), stranger = await account('stranger');
  await role(owner.user.id, 'branch_owner');

  const denied = await request(`/owner/yards/${yardId}`, 'PATCH', { hourlyPrice: 200000 }, stranger.accessToken);
  assert.equal(denied.status, 403);

  const changed = await request(`/owner/yards/${yardId}`, 'PATCH', { hourlyPrice: 200000 }, owner.accessToken);
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.hourly_price, 200000);

  const shown = await request(`/public/branches/${branchId}`);
  assert.equal(shown.body.data.yards[0].hourly_price, 200000);
});
```

Mỗi API cần ít nhất ba trường hợp: chạy đúng, người không có quyền bị từ chối, dữ liệu sai bị từ chối.

Giới hạn cần nhớ: một file test tạo được tối đa 10 tài khoản, vì hệ thống chỉ cho gửi 10 mã xác thực mỗi giờ từ một địa chỉ. Tạo tài khoản một lần ở đầu file rồi dùng lại cho nhiều test.

Tên test viết bằng tiếng Anh, mô tả hành vi, giống các test đang có.

## 6. Công thức thêm màn hình web

### 6.1. Ba quy tắc chung

- Không viết JavaScript ngay trong file HTML và không tải thư viện từ mạng. Backend bật chính sách bảo mật chỉ cho chạy file `.js` nằm trong chính thư mục `public`. Biểu đồ tự vẽ bằng thẻ `div` hoặc `svg`.
- Dữ liệu từ API luôn đưa lên trang bằng hàm `el(...)` với thuộc tính `text`. Không dùng `innerHTML`. Tên sân hay lý do hủy do người dùng nhập, đưa thẳng vào HTML là mở đường cho mã độc.
- Ẩn nút trên giao diện không phải là phân quyền. Quyền được chặn ở API.

### 6.2. Các hàm có sẵn trong `apps/admin/public/app.js`

| Hàm | Tác dụng |
|---|---|
| `el(tag, thuocTinh, con)` | Tạo một phần tử. `el('button', { class: 'small', text: 'Khóa' })` |
| `call(path, method, body)` | Gọi API kèm token, tự làm mới token khi hết hạn, trả về phần `data` |
| `table(columns, rows)` | Vẽ bảng. Mỗi cột có `title` và hàm `render` |
| `tag(status)` | Nhãn màu cho trạng thái |
| `money(value)`, `time(value)`, `short(id)` | Định dạng tiền, ngày giờ, mã rút gọn |
| `filter(label, options, onChange)` | Ô chọn để lọc |
| `act(button, work, done)` | Chạy một thao tác, hiện thông báo, tải lại màn hình |
| `notify(message, bad)` | Hiện thông báo ở đầu trang |
| `show(name, state)` | Chuyển sang một mục, `state` giữ điều kiện lọc |

### 6.3. Thêm một mục vào trang admin

Mỗi mục là một hàm trong đối tượng `views` và một dòng trong `titles`. Ví dụ mục Cơ sở:

```js
// thêm vào trong const views = { ... }
async venues(view, toolbar, state) {
  const input = el('input', { placeholder: 'Tên cơ sở', value: state.q || '' });
  toolbar.append(el('form', { class: 'toolbar', on: { submit: event => { event.preventDefault(); show('venues', { q: input.value.trim() }); } } },
    [el('label', {}, ['Tìm kiếm', input]), el('button', { type: 'submit', text: 'Tìm' })]));
  const rows = await call('/admin/branches' + (state.q ? '?q=' + encodeURIComponent(state.q) : ''));
  view.append(table([
    { title: 'Cơ sở', render: r => r.name },
    { title: 'Địa chỉ', wrap: true, render: r => r.address },
    { title: 'Trạng thái', render: r => tag(r.status) },
    { title: 'Xử lý', render: r => {
      const button = el('button', { class: 'small danger', text: 'Ẩn' });
      button.addEventListener('click', () => { const reason = prompt('Lý do ẩn cơ sở:');
        if (reason) act(button, () => call(`/admin/branches/${r.id}/hide`, 'POST', { reason: reason.trim() }), 'Đã ẩn cơ sở.'); });
      return button;
    } }], rows));
},
```

```js
// thêm vào const titles = { ... }
venues: 'Cơ sở',
```

Hàm `tag` chỉ tô xanh và đỏ cho các trạng thái nó biết. Thêm trạng thái mới vào hai danh sách `ok` và `bad` trong hàm đó.

### 6.4. Trang chủ sân

Trang chủ sân nằm ở `apps/owner/public`, mở tại `http://127.0.0.1:3000/owner/`. Trưởng nhóm dựng khung gồm đăng nhập, ô chọn cơ sở và thanh điều hướng. Khung cung cấp đối tượng `Portal` có đủ các hàm ở bảng 6.2, thêm:

| Hàm | Tác dụng |
|---|---|
| `Portal.page(ten, tieuDe, ham)` | Đăng ký một trang |
| `Portal.branch()` | Cơ sở đang được chọn, có `id` và `name` |
| `Portal.call(path, method, body, headers)` | Như `call`, thêm được header |

Mỗi trang là một file riêng trong `apps/owner/public/pages` để A và B không sửa chung file:

```js
// apps/owner/public/pages/venue.js
'use strict';
Portal.page('venue', 'Cơ sở và sân', async (view, toolbar, state) => {
  const { el, call, table, tag, money, act } = Portal;
  const yards = await call(`/owner/branches/${Portal.branch().id}/yards`);
  view.append(table([
    { title: 'Sân', render: r => r.name },
    { title: 'Giá mỗi giờ', render: r => money(r.hourly_price) },
    { title: 'Trạng thái', render: r => tag(r.active ? 'ACTIVE' : 'PAUSED') }], yards));
});
```

Thêm trang mới thì thêm một dòng `<script src="pages/ten-trang.js"></script>` vào cuối `apps/owner/public/index.html`.

Thao tác tạo mới có tiền hoặc có đơn cần header `Idempotency-Key`, mỗi lần bấm một giá trị mới:

```js
await Portal.call(`/owner/bookings/${id}/payments`, 'POST', body, { 'Idempotency-Key': crypto.randomUUID() });
```

## 7. Phần nền của trưởng nhóm

Làm xong trong ngày 12 và 13/10. Sau phần này ba bạn mới làm song song được.

### 7.1. Migration 011

```sql
-- 011_owner_admin_foundation.sql
ALTER TABLE booking.bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE booking.bookings ADD CONSTRAINT bookings_status_check CHECK(status IN
  ('PENDING_PAYMENT','AWAITING_CONFIRMATION','CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW','CANCELLED','EXPIRED'));
ALTER TABLE catalog.branches ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED','HIDDEN'));
ALTER TABLE catalog.branches ADD COLUMN auto_confirm boolean NOT NULL DEFAULT true;
```

### 7.2. Luật chuyển trạng thái đơn

Sửa `modules/booking/domain.ts`:

```ts
export type BookingStatus = 'PENDING_PAYMENT' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'CHECKED_IN' | 'COMPLETED' | 'NO_SHOW' | 'CANCELLED' | 'EXPIRED';
const transitions: Record<BookingStatus, BookingStatus[]> = {
  PENDING_PAYMENT: ['AWAITING_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'EXPIRED'],
  AWAITING_CONFIRMATION: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'NO_SHOW', 'CANCELLED'],
  CHECKED_IN: ['COMPLETED'],
  COMPLETED: [], NO_SHOW: [], CANCELLED: [], EXPIRED: []
};
```

Cập nhật test `booking state machine` trong `tests/unit/domain.test.ts` và danh sách trạng thái của `Booking` trong `packages/contracts/openapi.ts`.

| Mã | Hiển thị | Ai đưa đơn vào trạng thái này |
|---|---|---|
| `PENDING_PAYMENT` | Chờ thanh toán | Khách tạo đơn |
| `AWAITING_CONFIRMATION` | Chờ xác nhận | Thanh toán xong ở cơ sở đã tắt tự động xác nhận |
| `CONFIRMED` | Đã xác nhận | Thanh toán xong, hoặc chủ sân xác nhận, hoặc đơn tại quầy |
| `CHECKED_IN` | Đã nhận sân | Chủ sân |
| `COMPLETED` | Hoàn thành | Chủ sân |
| `NO_SHOW` | Không đến | Chủ sân |
| `CANCELLED` | Đã hủy | Khách, chủ sân hoặc admin |
| `EXPIRED` | Hết hạn thanh toán | Hệ thống |

### 7.3. Cơ sở không hoạt động thì khách không thấy và không đặt được

Trong `modules/catalog/service.ts`:

- `branches()`, `sports()` và `favorites()` chỉ lấy cơ sở có `b.status='ACTIVE'`.
- `branch(id)` trả 404 khi cơ sở ở trạng thái `HIDDEN`.
- `yard()` trả thêm cột `b.status AS branch_status`.

Trong `modules/booking/service.ts`:

- `quote()` thêm `invariant(yard.branch_status === 'ACTIVE', 'BRANCH_UNAVAILABLE', 'This venue is not taking bookings', 409)`.
- `availability()` thêm điều kiện `b.status='ACTIVE'`.

Không đặt điều kiện này vào bên trong `yard()`. Hàm `lock()` dùng `yard()` để khóa đơn khi hủy và khi xác nhận thanh toán. Chặn ở đó thì đơn đã đặt của một cơ sở bị ẩn sẽ không hủy được nữa.

### 7.4. Khung module và trang chủ sân

- `modules/owner/module.ts`, kèm API mẫu `GET /owner/branches` trả về các cơ sở mà tài khoản đang quản lý:

```ts
async branches(userId: string) {
  return (await this.db.query(`SELECT b.id,b.name,b.address,b.status,r.role FROM identity.roles r
    JOIN catalog.branches b ON b.id=r.branch_id
    WHERE r.user_id=$1 AND r.role IN ('branch_owner','branch_staff') ORDER BY b.name`, [userId])).rows;
}
```

- `OwnerModule` khai báo `imports: [CatalogModule, BookingModule]` và được thêm vào `apps/api/module.ts`.
- `apps/owner/public` gồm `index.html`, `app.js`, `style.css`, thư mục `pages`. Lấy `apps/admin/public` làm gốc.
- Một dòng trong `apps/api/bootstrap.ts`, ngay dưới dòng của `/admin`:

```ts
app.use('/owner', express.static(resolve('apps/owner/public'), { index: 'index.html', maxAge: 0 }));
```

- Một dòng trong `infra/Dockerfile`, ngay dưới dòng chép `apps/admin/public`:

```dockerfile
COPY --from=build --chown=node:node /app/apps/owner/public ./apps/owner/public
```

- File test mẫu `tests/integration/owner-venue.test.ts` có sẵn phần đầu và một test cho `GET /owner/branches`.

### 7.5. Tài khoản demo

Lệnh `npm run demo:accounts` tạo ba tài khoản trên database ở máy: một admin, một chủ sân của cơ sở demo, một khách hàng. Lệnh từ chối chạy khi `NODE_ENV=production`.

## 8. Việc của A: sân, dịch vụ, thu chi, thống kê

File của A: `modules/owner/venue.*`, `modules/owner/finance.*`, các trang `venue.js`, `services.js`, `finance.js`, `stats.js`, test `owner-venue.test.ts`, migration 012.

Làm theo thứ tự dưới đây. Mỗi bước là một pull request.

### A1. Xem và sửa thông tin cơ sở

API:

| Đường dẫn | Việc |
|---|---|
| `GET /owner/branches/:id` | Trả tên, địa chỉ, mô tả, giờ mở cửa, giờ đóng cửa, quy định, trạng thái, tùy chọn tự động xác nhận |
| `PATCH /owner/branches/:id` | Sửa các trường trên |

Dữ liệu nằm ở `catalog.branches`: `name`, `address`, `description`, `opening_hour`, `closing_hour`, `rules`, `status`, `auto_confirm`. Cột `rules` là một mảng chuỗi lưu dạng JSON.

Điều kiện phải kiểm tra trong service:

- `opening_hour` từ 0 đến 23, `closing_hour` từ 1 đến 24, và mở cửa phải nhỏ hơn đóng cửa.
- Chủ sân chỉ đổi trạng thái giữa `ACTIVE` và `PAUSED`. Cơ sở đang `HIDDEN` do admin ẩn thì trả 409, chủ sân không tự gỡ được.
- Không cho thu hẹp giờ mở cửa khi còn đơn sắp tới nằm ngoài khung giờ mới.

Mỗi lần sửa, tăng `version` lên 1 và đặt `updated_at=now()`, giống các bảng khác.

Xong khi: sửa giờ mở cửa ở trang chủ sân thì `GET /public/branches/:id` trả giờ mới. Cơ sở đặt `PAUSED` thì biến mất khỏi `GET /public/branches`.

### A2. Danh sách, thêm, sửa, tạm ngừng sân

API:

| Đường dẫn | Việc |
|---|---|
| `GET /owner/branches/:id/yards` | Mọi sân của cơ sở, kể cả sân đang tạm ngừng |
| `POST /owner/branches/:id/yards` | Thêm sân: tên, môn, giá mỗi giờ |
| `PATCH /owner/yards/:id` | Sửa tên, giá, trạng thái. Mẫu ở mục 3 |

Danh sách môn lấy từ `GET /public/sports`.

Bẫy quan trọng: không cho tạm ngừng một sân khi sân đó còn đơn sắp tới. Hàm `BookingService.lock()` chỉ khóa được sân đang hoạt động. Nếu sân bị tắt, khách không hủy được đơn và thanh toán không xác nhận được. Thêm kiểm tra này vào `updateYard`:

```ts
if (dto.active === false && yard.active) {
  const upcoming = await tx.query(`SELECT 1 FROM booking.bookings WHERE yard_id=$1 AND ends_at>now()
    AND status IN ('PENDING_PAYMENT','AWAITING_CONFIRMATION','CONFIRMED','CHECKED_IN') LIMIT 1`, [yardId]);
  invariant(!upcoming.rowCount, 'YARD_HAS_UPCOMING_BOOKINGS', 'Finish or cancel upcoming bookings before pausing this yard');
}
```

Đổi giá không ảnh hưởng đơn đã đặt, vì số tiền đã được chép vào đơn lúc giữ chỗ.

Xong khi: đủ bốn điều ở bảng phân công. Giá nhỏ hơn 1.000 bị từ chối với mã 400.

### A3. Dịch vụ đi kèm

Migration 012, phần một:

```sql
ALTER TABLE catalog.services ADD COLUMN active boolean NOT NULL DEFAULT true;
```

API:

| Đường dẫn | Việc |
|---|---|
| `GET /owner/branches/:id/services` | Mọi dịch vụ, kể cả đã ngừng bán |
| `POST /owner/branches/:id/services` | Thêm: tên, giá |
| `PATCH /owner/services/:id` | Sửa tên, giá, trạng thái |

Hai chỗ có sẵn phải sửa theo, mỗi chỗ thêm điều kiện `AND active`:

- `CatalogService.services()` trong `modules/catalog/service.ts`, để khách không thấy dịch vụ đã ngừng.
- `BookingService.addService()` trong `modules/booking/service.ts`, ở câu `SELECT * FROM catalog.services WHERE id=$1 AND branch_id=$2`, để khách không thêm được dịch vụ đã ngừng vào đơn.

Không xóa dịch vụ. Bảng `booking.services` đang trỏ tới nó, xóa sẽ lỗi và làm mất lịch sử đơn.

### A4. Thu chi: tiền cọc, thu tại sân, hoàn tiền

Tiền trả online đã có sẵn trong `payment.intents` và `payment.refunds`. Phần của A là sổ ghi các khoản chủ sân thu và trả trực tiếp.

Migration 012, phần hai:

```sql
CREATE TABLE booking.counter_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES booking.bookings,
  kind text NOT NULL CHECK(kind IN ('DEPOSIT','PAYMENT','REFUND')),
  amount integer NOT NULL CHECK(amount>0), method text NOT NULL CHECK(method IN ('CASH','TRANSFER')),
  note text NOT NULL DEFAULT '', recorded_by uuid NOT NULL REFERENCES identity.users,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON booking.counter_payments(booking_id);
```

`DEPOSIT` là tiền cọc, `PAYMENT` là thanh toán, `REFUND` là tiền chủ sân trả lại tại quầy.

API:

| Đường dẫn | Việc |
|---|---|
| `GET /owner/branches/:id/payments?from=&to=` | Mỗi đơn một dòng với năm con số bên dưới |
| `POST /owner/bookings/:id/payments` | Ghi một khoản: loại, số tiền, hình thức, ghi chú |
| `GET /owner/branches/:id/refunds` | Các lệnh hoàn tiền online của cơ sở, lấy từ `payment.refunds` nối qua `payment.intents.booking_id` |

Năm con số của một đơn:

| Con số | Cách tính |
|---|---|
| Tổng tiền | `booking.bookings.amount` |
| Đã thu online | `payment.intents.amount` khi `status='SUCCEEDED'` |
| Đã thu tại sân | Tổng `DEPOSIT` và `PAYMENT` trừ tổng `REFUND` |
| Đã hoàn online | `payment.refunds.amount` khi `status='SUCCEEDED'` |
| Còn phải thu | Tổng tiền trừ đã thu online trừ đã thu tại sân, không nhỏ hơn 0 |

Luật khi ghi một khoản, kiểm tra trong cùng transaction sau khi khóa dòng đơn bằng `SELECT ... FOR UPDATE`:

- Đơn `CANCELLED` hoặc `EXPIRED` chỉ nhận loại `REFUND`.
- Khoản thu không làm tổng đã thu vượt tổng tiền của đơn.
- Khoản `REFUND` không vượt số đã thu tại sân.
- Dùng `this.idem.run(...)` để bấm hai lần không ghi hai khoản.
- Ghi `access.audit` với hành động `counter_payment.record`.

Việc hoàn tiền online không nằm ở đây. Khi chủ sân từ chối đơn hoặc chấp nhận hủy, phần của B gọi `RefundService` và lệnh hoàn tự chạy.

Tổng tiền từ SQL trả về kiểu `bigint` sẽ thành chuỗi trong JSON. Ép về chuỗi một cách rõ ràng như `AdminService.stats()` đang làm, và để hàm `money()` ở giao diện lo định dạng.

### A5. Thống kê doanh thu và tình hình sử dụng sân

API: `GET /owner/branches/:id/stats?from=2026-10-01&to=2026-10-31&yardId=`. Giới hạn khoảng ngày tối đa 92 ngày.

Trả về:

```json
{
  "totals": { "revenue": "5400000", "refunded": "180000", "bookings": 31, "cancelled": 4, "utilization": 0.27 },
  "days": [ { "day": "2026-10-01", "revenue": "360000", "bookings": 2 } ],
  "yards": [ { "id": "...", "name": "Sân 1", "hours": 46, "revenue": "..." } ]
}
```

Định nghĩa, ghi rõ trong code để cả nhóm hiểu như nhau:

- Đơn được tính doanh thu là đơn ở trạng thái `CONFIRMED`, `CHECKED_IN`, `COMPLETED` hoặc `NO_SHOW`.
- Doanh thu tính theo ngày chơi, tức ngày của `starts_at` theo giờ địa phương của cơ sở.
- Tỷ lệ sử dụng bằng tổng số giờ của các đơn được tính, chia cho số sân đang hoạt động nhân số giờ mở cửa mỗi ngày nhân số ngày.

Mẫu câu SQL gom theo ngày, ngày không có đơn vẫn có dòng với số 0:

```sql
SELECT d::date AS day, coalesce(sum(k.amount),0)::bigint AS revenue, count(k.id)::int AS bookings
FROM generate_series($2::date, $3::date, interval '1 day') d
LEFT JOIN booking.bookings k ON k.branch_id=$1
  AND k.status IN ('CONFIRMED','CHECKED_IN','COMPLETED','NO_SHOW')
  AND (k.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = d::date
GROUP BY d ORDER BY d
```

Trong code thật, lấy múi giờ từ cột `timezone` của cơ sở thay cho chuỗi viết cứng.

Biểu đồ: mỗi ngày một cột `div`, chiều cao theo tỷ lệ với ngày cao nhất. Không dùng thư viện biểu đồ, xem mục 6.1.

Xong khi: tạo vài đơn bằng dữ liệu demo rồi cộng tay, số trên trang khớp. Khoảng ngày không có đơn hiện dòng Không có dữ liệu.

## 9. Việc của B: lịch sân, đơn đặt, hủy đơn

File của B: `modules/owner/bookings.*`, các trang `schedule.js`, `bookings.js`, `cancel-requests.js`, test `owner-bookings.test.ts`, migration 013. B cũng sửa vài chỗ trong `modules/booking/service.ts`. Những chỗ đó cần trưởng nhóm duyệt kỹ.

Trước khi viết dòng code nào, đọc hết `modules/booking/service.ts`. Bốn điều phải nắm:

1. Một lượt đặt gồm ba dòng: `booking.holds` giữ chỗ 5 phút, `booking.reservations` chiếm khung giờ trên lịch, `booking.bookings` là đơn.
2. Bảng `booking.reservations` có ràng buộc `no_yard_overlap`. Database tự từ chối hai dòng đang hiệu lực trùng giờ trên cùng một sân. Khi đó API trả 409 với mã `SLOT_UNAVAILABLE` mà bạn không phải viết gì. Đừng tự viết đoạn kiểm tra trùng lịch.
3. Mọi thao tác ghi đều khóa theo thứ tự sân, rồi đơn, rồi thanh toán. Gọi `this.catalog.yard(tx, yardId, true)` để khóa sân, hoặc `this.booking.lock(tx, bookingId)` để khóa cả sân lẫn đơn. Khóa sai thứ tự gây treo lẫn nhau.
4. Đổi trạng thái đơn luôn đi qua `this.booking.transition(...)`. Hàm này kiểm tra luật chuyển trạng thái, ghi `booking.status_history` và gửi thông báo cho khách.

### B1. Lịch theo ngày và danh sách đơn

API:

| Đường dẫn | Việc |
|---|---|
| `GET /owner/branches/:id/schedule?date=2026-10-20` | Dữ liệu cho lưới lịch một ngày |
| `GET /owner/branches/:id/bookings?from=&to=&status=&yardId=&page=` | Danh sách đơn có phân trang |
| `GET /owner/bookings/:id` | Chi tiết một đơn |

`schedule` trả về:

```json
{
  "date": "2026-10-20", "openingHour": 6, "closingHour": 23,
  "yards": [ { "id": "...", "name": "Sân 1", "active": true } ],
  "bookings": [ { "id": "...", "yard_id": "...", "starts_at": "...", "ends_at": "...", "status": "CONFIRMED", "customer": "Nguyễn An" } ],
  "blocks": [ { "id": "...", "yard_id": "...", "starts_at": "...", "ends_at": "...", "reason": "Bảo trì" } ]
}
```

Ngày được hiểu theo giờ địa phương của cơ sở. Đổi một ngày thành khoảng thời gian như sau:

```sql
SELECT ($2::date::timestamp AT TIME ZONE b.timezone) AS from_ts,
       (($2::date + 1)::timestamp AT TIME ZONE b.timezone) AS to_ts
FROM catalog.branches b WHERE b.id=$1
```

Rồi lấy đơn có `starts_at < to_ts AND ends_at > from_ts` và không ở trạng thái `CANCELLED`, `EXPIRED`.

Chi tiết đơn gồm thông tin đơn, tên và số điện thoại hoặc email của khách từ `identity.users`, tên sân, và các dòng `booking.status_history` theo thứ tự thời gian.

Danh sách đơn phân trang theo mẫu `BookingService.list()`: trả `{ items, page, pageSize, total }`.

Giao diện: lưới có cột là sân, hàng là giờ từ `openingHour` đến `closingHour`. Ô có đơn tô màu theo trạng thái. Bấm vào ô mở chi tiết.

### B2. Khóa và mở khung giờ

Migration 013, phần một:

```sql
CREATE TABLE booking.blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), yard_id uuid NOT NULL REFERENCES catalog.yards,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES identity.users, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(ends_at>starts_at)
);
ALTER TABLE booking.reservations ALTER COLUMN hold_id DROP NOT NULL;
ALTER TABLE booking.reservations ADD COLUMN block_id uuid UNIQUE REFERENCES booking.blocks ON DELETE CASCADE;
ALTER TABLE booking.reservations ADD CONSTRAINT reservation_source CHECK(hold_id IS NOT NULL OR block_id IS NOT NULL);
```

Ý tưởng: một khung giờ khóa cũng chiếm chỗ trong `booking.reservations` như một lượt đặt. Nhờ vậy ràng buộc `no_yard_overlap` tự chặn việc khóa đè lên đơn, và câu truy vấn lịch trống của app khách tự thấy khung giờ đó đã kín. Không phải sửa gì ở phía khách.

API:

| Đường dẫn | Việc |
|---|---|
| `POST /owner/yards/:id/blocks` | Khóa: giờ bắt đầu, giờ kết thúc, lý do |
| `DELETE /owner/blocks/:id` | Mở khóa |

Trình tự trong transaction khi khóa:

1. Khóa sân: `const yard = await this.catalog.yard(tx, yardId, true)`.
2. Kiểm tra quyền: `await this.access.owner(userId, yard.branch_id, tx)`.
3. Dọn chỗ giữ đã hết hạn: `await this.booking.expireYard(tx, yardId)`.
4. Thêm dòng vào `booking.blocks`.
5. Thêm dòng vào `booking.reservations` với `yard_id`, `block_id`, `starts_at`, `ends_at`, để trống `expires_at`.
6. Ghi `access.audit` với hành động `yard.block`.

Giờ khóa phải tròn giờ và nằm trong tương lai. Không dùng `validateSlot` cho việc này vì hàm đó giới hạn tối đa 8 giờ, trong khi bảo trì có thể kéo dài cả ngày.

Mở khóa: xóa dòng trong `booking.blocks`. Dòng `reservations` tương ứng tự mất nhờ `ON DELETE CASCADE`.

### B3. Hàm hủy đơn dùng chung

Viết hàm này đầu tuần 2. Phần hủy hộ của C phải có nó trước thứ Tư 21/10.

```ts
// modules/booking/service.ts
/** Cancels on the venue's or an administrator's side: frees the slot and refunds the given share of what was paid. */
async cancelByStaff(tx: DbClient, row: any, actorId: string, reason: string, percent: number, requestId: string) {
  const paid = row.status !== 'PENDING_PAYMENT';
  await this.transition(tx, row, 'CANCELLED', reason, actorId, requestId);
  await tx.query('UPDATE booking.reservations SET active=false WHERE booking_id=$1', [row.id]);
  return paid && percent > 0 ? this.refunds.request(tx, 'booking', row.id, percent, reason, requestId) : null;
}
```

Người gọi phải khóa đơn trước bằng `this.booking.lock(tx, id)` và tự kiểm tra quyền. `refunds.request` trả `null` khi đơn chưa có khoản thanh toán online nào, ví dụ đơn tại quầy. Mỗi khoản thanh toán chỉ có một lệnh hoàn. Gọi lần hai nhận lại lệnh cũ.

### B4. Xác nhận và từ chối đơn

Sửa `BookingService.confirm()`. Hàm này chạy khi thanh toán thành công. Hiện nó luôn đưa đơn sang `CONFIRMED`. Đổi thành:

```ts
const auto = (await tx.query('SELECT auto_confirm FROM catalog.branches WHERE id=$1', [row.branch_id])).rows[0].auto_confirm;
await this.transition(tx, row, auto ? 'CONFIRMED' : 'AWAITING_CONFIRMATION', 'signed payment webhook', undefined, requestId);
```

Mặc định `auto_confirm` là bật, nên 33 test tích hợp đang có vẫn phải qua mà không sửa.

Ba chỗ khác đang ngầm hiểu `CONFIRMED` là đã trả tiền. Sửa cả ba:

| Chỗ | Sửa thành |
|---|---|
| `BookingService.cancel()`, dòng `const paid = row.status === 'CONFIRMED'` | Đơn `AWAITING_CONFIRMATION` cũng là đã trả tiền và cũng hủy được |
| `BookingService.review()`, điều kiện `booking.status === 'CONFIRMED'` | Cho đánh giá cả khi đơn `CHECKED_IN` hoặc `COMPLETED` |
| `AdminService.stats()` | Báo cho C biết để đếm thêm trạng thái mới |

API của chủ sân:

| Đường dẫn | Việc |
|---|---|
| `POST /owner/bookings/:id/confirm` | `AWAITING_CONFIRMATION` sang `CONFIRMED` |
| `POST /owner/bookings/:id/reject` | Nhận lý do bắt buộc, gọi `cancelByStaff` với mức hoàn 100 |
| `POST /owner/bookings/:id/status` | Nhận `CHECKED_IN`, `COMPLETED` hoặc `NO_SHOW` |

Cả ba dùng `@HttpCode(200)`. Trình tự chung: đọc `branch_id` của đơn, kiểm tra `access.owner`, khóa đơn bằng `lock`, gọi `transition` hoặc `cancelByStaff`, ghi `access.audit`.

Luật thêm cho trạng thái sử dụng: chỉ đánh dấu `CHECKED_IN` trong vòng một giờ trước giờ bắt đầu trở đi, và chỉ đánh dấu `NO_SHOW` sau giờ bắt đầu.

### B5. Yêu cầu hủy

Hôm nay khách tự hủy được khi còn từ 2 giờ trở lên trước giờ chơi. Dưới 2 giờ, `cancel()` trả lỗi `CANCELLATION_WINDOW_CLOSED`. Phần mới: trong trường hợp đó khách gửi yêu cầu và chủ sân quyết định.

Migration 013, phần hai:

```sql
CREATE TABLE booking.cancel_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES booking.bookings,
  user_id uuid NOT NULL REFERENCES identity.users, reason text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
  refund_percent integer CHECK(refund_percent BETWEEN 0 AND 100),
  decided_by uuid REFERENCES identity.users, decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz
);
CREATE UNIQUE INDEX cancel_requests_one_pending ON booking.cancel_requests(booking_id) WHERE status='PENDING';
```

Chỉ mục cuối bảo đảm một đơn chỉ có một yêu cầu đang chờ. Gửi lần hai, database từ chối và API tự trả 409.

API:

| Đường dẫn | Ai gọi | Việc |
|---|---|---|
| `POST /bookings/:id/cancel-requests` | Khách | Gửi yêu cầu kèm lý do. Đặt trong `modules/booking/controller.ts` |
| `GET /owner/branches/:id/cancel-requests?status=` | Chủ sân | Danh sách |
| `POST /owner/cancel-requests/:id/approve` | Chủ sân | Nhận mức hoàn từ 0 đến 100 và ghi chú, gọi `cancelByStaff` |
| `POST /owner/cancel-requests/:id/reject` | Chủ sân | Nhận ghi chú, đơn giữ nguyên |

Luật:

- Khách chỉ gửi yêu cầu cho đơn của chính mình, khi đơn ở `AWAITING_CONFIRMATION` hoặc `CONFIRMED` và chưa tới giờ kết thúc.
- Khi chủ sân quyết định, gửi thông báo cho khách: `emitEvent(tx, request.user_id, 'booking.cancel_request_approved', { bookingId }, requestId)`, tương tự với `rejected`.
- Lý do hủy là dữ liệu do người dùng nhập. Giới hạn 500 ký tự trong DTO.
- Thêm một dòng vào hàm `purge` trong `modules/identity/service.ts` để xóa trắng lý do của người đã xóa tài khoản: `UPDATE booking.cancel_requests SET reason='' WHERE user_id=$1`.

### B6. Tạo đơn tại quầy

Migration 013, phần ba:

```sql
ALTER TABLE booking.bookings ADD COLUMN source text NOT NULL DEFAULT 'ONLINE' CHECK(source IN ('ONLINE','COUNTER'));
ALTER TABLE booking.bookings ADD COLUMN customer_name text;
ALTER TABLE booking.bookings ADD COLUMN customer_phone text;
```

API: `POST /owner/branches/:id/bookings` nhận sân, giờ bắt đầu, giờ kết thúc, tên khách, số điện thoại khách. Cần header `Idempotency-Key`.

Bảng `booking.bookings` bắt buộc có `user_id` và `hold_id`, nên đơn tại quầy vẫn tạo đủ ba dòng. Làm theo đúng trình tự của `BookingService.createSeries()`:

1. `this.idem.run(userId, 'owner-booking', key, dto, async tx => { ... })`.
2. Khóa sân, kiểm tra `access.owner`, gọi `expireYard`.
3. `const quote = await this.booking.quote({ yardId, startsAt, endsAt }, tx)`. Hàm này đã kiểm tra giờ tròn, nằm trong tương lai và trong giờ mở cửa, rồi tính tiền.
4. Tìm tài khoản khách theo số điện thoại. Chuẩn hóa số bằng `normalizeIdentifier` trong `modules/identity/service.ts`. Có tài khoản thì đơn thuộc về khách đó. Không có thì đơn đứng tên chính chủ sân, tên và số điện thoại khách lưu ở hai cột mới.
5. Thêm `booking.holds` với trạng thái `CONVERTED`.
6. Thêm `booking.reservations` với `expires_at` để trống.
7. Thêm `booking.bookings` với `status='CONFIRMED'`, `source='COUNTER'`, `payment_expires_at=now()`.
8. Thêm dòng `booking.status_history` với lý do `counter booking`, ghi `access.audit`.

Nếu khung giờ đã có người đặt, bước 6 bị database từ chối và API tự trả 409 `SLOT_UNAVAILABLE`.

Tiền của đơn tại quầy do chủ sân ghi nhận ở trang Thu chi của A. Báo A biết khi cột `source` đã có.

Thêm vào hàm `purge` một dòng xóa trắng `customer_name` và `customer_phone` của các đơn thuộc người đã xóa tài khoản.

### B7. Nếu còn thời gian: đổi sân hoặc đổi giờ

Trong một transaction: tắt dòng `reservations` cũ, thêm dòng mới, cập nhật `yard_id`, `starts_at`, `ends_at`, `amount` của đơn. Nếu khung giờ mới đã kín, database từ chối và cả transaction quay lại như cũ. Chỉ làm khi B1 đến B6 đã xong và có test.

## 10. Việc của C: admin toàn hệ thống

File của C: `modules/admin/*`, `apps/admin/public/*`, test `admin.test.ts`, `scripts/create-admin.ts`. Trang admin đã có khung, C mở rộng từng mục.

Mọi tham số lọc mới phải được khai báo trong `AdminListQuery` ở `modules/admin/dto.ts`. Gửi một tham số chưa khai báo thì API trả 400.

### C1. Tài khoản khách hàng và chủ sân

Mở rộng `AdminService.users()`: thêm lọc theo vai trò, trả kèm tổng số dòng để phân trang.

API mới:

| Đường dẫn | Việc |
|---|---|
| `GET /admin/users/:id` | Thông tin tài khoản, số đơn đã đặt, các vai trò kèm tên cơ sở |
| `POST /admin/users/:id/lock` | Nhận lý do, đặt `status='DISABLED'`, thu hồi mọi phiên |
| `POST /admin/users/:id/unlock` | Đặt lại `status='ACTIVE'` |

Khóa tài khoản trong một transaction:

```ts
await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['admin-role-changes']);
await this.access.admin(actorId, tx);
invariant(actorId !== userId, 'CANNOT_LOCK_SELF', 'An administrator cannot lock their own account');
// nếu người bị khóa là admin: đếm số admin đang hoạt động như trong revoke(), còn 1 thì từ chối với LAST_ADMIN
const row = (await tx.query(`UPDATE identity.users SET status='DISABLED',version=version+1,updated_at=now()
  WHERE id=$1 AND status='ACTIVE' RETURNING id,status`, [userId])).rows[0];
invariant(row, 'NOT_FOUND', 'Active user not found', 404);
await tx.query('UPDATE identity.refresh_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
await this.access.audit(tx, actorId, 'user.lock', 'user', userId, requestId, { reason });
```

Không cần sửa phần đăng nhập. `login()` và `AuthGuard` đã từ chối mọi tài khoản không ở trạng thái `ACTIVE`.

Mở khóa chỉ áp dụng cho tài khoản đang `DISABLED`. Tuyệt đối không đổi trạng thái của tài khoản `DELETION_REQUESTED` hoặc `DELETED`, vì đó là tài khoản người dùng đã yêu cầu xóa.

Lý do khóa lưu trong phần chi tiết của nhật ký, không cần cột mới.

Giao diện: mục Người dùng thêm ô lọc vai trò và trạng thái, nút Khóa và Mở khóa trên từng dòng, bấm vào dòng mở chi tiết. Phần cấp quyền đã có, sắp lại cho dễ dùng: chọn vai trò `branch_owner` thì bắt buộc chọn cơ sở.

Test bắt buộc: tài khoản bị khóa gọi `GET /users/me` nhận 401, đăng nhập lại nhận 401, mở khóa xong đăng nhập được.

### C2. Thông tin sân trên toàn hệ thống

Chú ý trước khi sửa `GET /admin/branches`: hàm `start()` trong `app.js` gọi API này lúc đăng nhập để nạp danh sách cơ sở cho ô cấp quyền và để biết tài khoản có phải admin không. Khi thêm tìm kiếm và phân trang, giữ cho lời gọi không tham số vẫn trả mảng có `id`, `name`, `address`, hoặc sửa `start()` cùng lúc.

API:

| Đường dẫn | Việc |
|---|---|
| `GET /admin/branches?q=&status=&page=` | Thêm tìm theo tên, lọc trạng thái, trả thêm `status` và số sân |
| `GET /admin/branches/:id` | Chi tiết: địa chỉ, giờ mở cửa, các sân và giá, chủ sân đang quản lý |
| `POST /admin/branches` | Tạo cơ sở mới |
| `POST /admin/branches/:id/hide` | Nhận lý do bắt buộc, đặt `status='HIDDEN'` |
| `POST /admin/branches/:id/restore` | Đặt lại `status='ACTIVE'` |

Tìm theo tên không dấu: dùng lại cách của `CatalogService`, `unaccent(b.name) ILIKE '%' || unaccent($1) || '%'`, và thoát các ký tự `%`, `_`, `\` trong từ khóa như `AdminService.users()` đang làm.

Tạo cơ sở cần ba thứ mà biểu mẫu phải hỏi đủ:

- Một dòng `catalog.shops` với tên đơn vị. Tạo trước rồi lấy `id`.
- Tọa độ. Cột `location` bắt buộc có: `ST_SetSRID(ST_MakePoint($kinhDo,$viDo),4326)::geography`. Chú ý kinh độ đứng trước vĩ độ.
- Giờ mở cửa và đóng cửa.

Sau khi tạo, gán chủ sân bằng API có sẵn `POST /admin/roles` với vai trò `branch_owner` và mã cơ sở.

Ẩn cơ sở chỉ đổi cột `status`. Không xóa sân, đơn hay giao dịch. Lý do ẩn lưu trong nhật ký. Nhờ phần nền ở mục 7.3, cơ sở bị ẩn tự biến mất khỏi app khách hàng.

Test bắt buộc: ẩn xong thì `GET /public/branches` không còn cơ sở đó và `GET /public/branches/:id` trả 404. Khôi phục xong thì thấy lại. Các đơn cũ của cơ sở vẫn còn nguyên.

### C3. Giám sát đơn đặt và hỗ trợ xử lý

Mở rộng `AdminService.bookings()`: lọc theo cơ sở, khách hàng, khoảng ngày chơi, trạng thái. Trả kèm tổng số dòng.

API mới:

| Đường dẫn | Việc |
|---|---|
| `GET /admin/bookings/:id` | Đơn, khách, cơ sở, sân, lịch sử trạng thái, khoản thanh toán, lệnh hoàn tiền, yêu cầu hủy nếu có |
| `POST /admin/bookings/:id/cancel` | Nhận lý do và mức hoàn, hủy hộ |

Hủy hộ dùng hàm `BookingService.cancelByStaff` do B viết ở bước B3:

```ts
return this.db.transaction(async tx => {
  await this.access.admin(actorId, tx);
  const row = await this.booking.lock(tx, bookingId);
  const refund = await this.booking.cancelByStaff(tx, row, actorId, dto.reason, dto.percent, requestId);
  await this.access.audit(tx, actorId, 'booking.cancel_by_admin', 'booking', bookingId, requestId, { reason: dto.reason, percent: dto.percent });
  return { ...row, refund };
});
```

Để dùng `BookingService`, thêm `imports: [BookingModule]` vào `modules/admin/module.ts`.

Trong lúc chờ B, làm trước phần lọc và trang chi tiết.

Giao diện: mục Đặt sân thêm ô chọn cơ sở, ô tìm khách, hai ô ngày, ô trạng thái có đủ tám trạng thái. Bấm vào một dòng mở chi tiết. Mục Hoàn tiền và mục Thanh toán giữ nguyên.

### C4. Quản trị và kiểm soát hoạt động hệ thống

Tổng quan. Mở rộng `AdminService.stats()`:

- Đếm thêm các trạng thái đơn mới.
- Thêm chuỗi 14 ngày gần nhất: số đơn, doanh thu, tài khoản mới mỗi ngày. Dùng `generate_series` như mẫu ở mục A5.
- Vẽ biểu đồ cột bằng `div`.

Tình trạng hệ thống. API `GET /admin/system` trả:

| Mục | Lấy từ đâu |
|---|---|
| Database | Chạy một câu truy vấn nhỏ, như `HealthController` trong `apps/api/module.ts` |
| Redis | `this.redis.client.ping()` |
| Thông báo đang chờ gửi | `SELECT count(*) FROM platform.outbox_events WHERE queued_at IS NULL` |
| Chỗ giữ đã quá hạn chưa dọn | `SELECT count(*) FROM booking.reservations WHERE active AND expires_at<=now()` |
| Lệnh hoàn tiền đang mở | `payment.refunds` với trạng thái `PENDING`, `MANUAL_REVIEW`, `FAILED` |

Từng mục bọc trong `try` riêng để một phần lỗi không làm hỏng cả trang. Hai con số ở giữa lớn bất thường nghĩa là tiến trình worker đang không chạy.

Nhật ký. Mở rộng `AdminService.audit()`: lọc theo người thực hiện, hành động, khoảng ngày, có phân trang. Hiện đang lấy cứng 100 dòng mới nhất.

Lệnh tạo admin. Viết `scripts/create-admin.ts` theo khuôn `scripts/seed.ts`:

- Nhận email hoặc số điện thoại của một tài khoản đã đăng ký.
- Tài khoản phải tồn tại và đang `ACTIVE`, nếu không thì báo lỗi và dừng.
- Thêm vai trò `admin` và ghi một dòng `platform.audit_events`.
- Thêm vào `package.json`: `"admin:create": "node --env-file-if-exists=.env dist/scripts/create-admin.js"`.

Lệnh không tạo tài khoản mới và không đặt mật khẩu. Hệ thống không có mật khẩu mặc định và phải giữ như vậy.

### C5. Tuần 3: kiểm thử chéo và dữ liệu demo

- Viết kịch bản thử cho từng chức năng trong mười chức năng, mỗi kịch bản năm đến mười bước, lưu ở `docs/KICH_BAN_KIEM_THU.md`.
- Chia cho ba người thử chéo ngày 29 và 30/10. Mỗi lỗi là một issue trên GitHub, ghi các bước tái hiện.
- Chuẩn bị dữ liệu demo: hai chủ sân, ba khách, khoảng hai mươi đơn ở đủ các trạng thái.

## 11. Những bẫy đã biết trong dự án

| Hiện tượng | Nguyên nhân và cách xử lý |
|---|---|
| Sửa code xong chạy vẫn như cũ | Chưa chạy `npm.cmd run build` |
| API mới trả 404 | Chưa đăng ký controller trong module, hoặc chưa thêm module vào `apps/api/module.ts` |
| Gọi API có tham số lọc thì nhận 400 `VALIDATION_FAILED` | Tham số chưa khai báo trong DTO |
| `POST` trả 201 trong khi test chờ 200 | `POST` mặc định là 201. Thao tác không tạo mới thì thêm `@HttpCode(200)` |
| API trả 500 khi nhập số âm | Vi phạm ràng buộc `CHECK` của database không được đổi thành lỗi dễ hiểu. Kiểm tra dữ liệu trong DTO hoặc bằng `invariant` trước khi ghi |
| Trùng khung giờ thì trả 409 `SLOT_UNAVAILABLE` dù không viết gì | Đúng thiết kế. Database chặn và `packages/observability/http.ts` đổi thành lỗi này |
| Thêm trùng dữ liệu thì trả 409 `CONFLICT` | Như trên, với ràng buộc duy nhất |
| `Migration changed after applying` | Đã sửa một file migration đã chạy. Xem mục 4 |
| Tổng tiền trả về là chuỗi `"5400000"` | PostgreSQL trả `bigint` dạng chuỗi. Giữ nguyên, định dạng ở giao diện |
| Thống kê lệch một ngày | Quên đổi sang giờ địa phương. Dùng `AT TIME ZONE` với cột `timezone` của cơ sở |
| Trang web trắng, bảng điều khiển báo `Content Security Policy` | Có JavaScript viết trong HTML hoặc tải từ mạng. Xem mục 6.1 |
| Ảnh sân không hiện trong trang web | Cùng chính sách đó chặn ảnh từ máy chủ khác. Trang chủ sân và admin không cần hiện ảnh |
| Test báo 429 hoặc không tạo được tài khoản | Một file test đã tạo quá 10 tài khoản. Xem mục 5 |
| Khách không hủy được đơn sau khi sân bị tạm ngừng | `lock()` chỉ khóa được sân đang hoạt động. Xem bước A2 |
| Hoàn tiền lần hai không tạo lệnh mới | Mỗi khoản thanh toán chỉ có một lệnh hoàn. `refunds.request` trả lại lệnh cũ |
| `refunds.request` báo `INVALID_REFUND` | Mức hoàn phải từ 1 đến 100. Mức 0 thì không gọi hàm này |
| Đơn tạo hai lần khi bấm nhanh hai lần | Thiếu `this.idem.run` hoặc thiếu header `Idempotency-Key` |
| Trang web báo quá nhiều yêu cầu | Giới hạn 180 yêu cầu mỗi phút cho một địa chỉ. Đừng tự động tải lại quá nhanh |

Về tiền: mọi số tiền là số nguyên đồng. Không dùng số thập phân.

Về giờ: khung giờ đặt sân luôn tròn giờ, dài từ 1 đến 8 giờ, bắt đầu trong tương lai và không quá 90 ngày tới. Luật này nằm trong `validateSlot` ở `modules/booking/domain.ts`.

Về dữ liệu cá nhân: log không được ghi email, số điện thoại, mã xác thực hay token. Khi thêm bảng có dữ liệu cá nhân, thêm một dòng vào hàm `purge` trong `modules/identity/service.ts`.

## 12. Trước khi mở pull request

Chạy đủ bốn lệnh, tất cả phải qua:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration
npm.cmd run openapi
```

Tự soát:

- [ ] Nhánh tách từ `main` mới nhất, tên dạng `feat/owner-yards`.
- [ ] Mỗi API mới có test cho ba trường hợp: chạy đúng, không có quyền, dữ liệu sai.
- [ ] Mọi API chủ sân gọi `access.owner`, mọi API admin gọi `access.admin`.
- [ ] Mọi thao tác ghi dữ liệu có `access.audit`.
- [ ] Câu SQL chỉ dùng tham số `$1`, `$2`, không ghép chuỗi từ dữ liệu người dùng.
- [ ] Danh sách có `LIMIT` và phân trang.
- [ ] Giao diện không dùng `innerHTML`, không có JavaScript trong file HTML.
- [ ] Không còn `console.log` thử nghiệm.
- [ ] Không có file `.env`, thư mục `secrets` hay mật khẩu trong commit.
- [ ] `docs/openapi.json` đã được sinh lại và nằm trong commit.
- [ ] Mô tả pull request ghi: làm gì, thử thế nào, kèm ảnh chụp màn hình nếu có giao diện.

Tên commit theo mẫu `feat: thêm API sửa giá sân`, `fix: ...`, `test: ...`, `docs: ...`.

Trên GitHub, mục Backend checks phải xanh. Mục đó chạy lại đúng bốn lệnh trên, thêm kiểm tra thư viện và build Docker.

## 13. Kịch bản demo cuối

Ngày 01/11 cả nhóm chạy trọn kịch bản này trên một máy:

1. Admin đăng nhập trang `/admin`, tạo một cơ sở mới và gán chủ sân.
2. Chủ sân đăng nhập trang `/owner`, thêm hai sân, đặt giá, thêm dịch vụ thuê vợt, tắt tự động xác nhận.
3. Khách mở app Android, tìm thấy cơ sở mới, đặt một khung giờ và thanh toán thử.
4. Chủ sân thấy đơn ở mục Chờ xác nhận và bấm Xác nhận. Khách nhận thông báo.
5. Chủ sân khóa một khung giờ để bảo trì. Trên app khách, khung giờ đó không còn đặt được.
6. Chủ sân tạo một đơn tại quầy và ghi nhận tiền cọc ở trang Thu chi.
7. Khách gửi yêu cầu hủy đơn ở bước 3. Chủ sân chấp nhận với mức hoàn 50 phần trăm. Lệnh hoàn tiền xuất hiện.
8. Chủ sân mở trang Thống kê, số liệu khớp với các đơn vừa tạo.
9. Admin tra lại đơn đã hủy, xem lịch sử trạng thái và lệnh hoàn tiền.
10. Admin khóa tài khoản khách. Khách bị đăng xuất khỏi app.
11. Admin ẩn cơ sở. Cơ sở biến mất khỏi app khách.
12. Admin mở Nhật ký và chỉ ra từng thao tác ở trên.
