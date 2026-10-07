# Bộ thu thập sân

Đọc thông tin sân từ trang đặt lịch công khai `datlich.alobo.vn`: mở trang bằng Edge không giao diện, lọc theo môn, mở lần lượt từng sân gần nhất và đọc những gì trang hiển thị (cây accessibility). Chỉ dùng khi đã được nền tảng và chủ sân cho phép; dữ liệu chỉ phục vụ bản chạy localhost.

Giới hạn cố ý của công cụ:

- Không đăng nhập, không gọi API riêng của trang, không giải mã dữ liệu trang tải về.
- Không mở tab đánh giá (có tên người dùng).
- Mỗi lúc một trang, một sân; mỗi sân mất khoảng 13 giây.

## Chạy

Cần Microsoft Edge và Node 24. `playwright-core` không nằm trong dependency của backend:

```powershell
cd tools\venue-collector
npm.cmd install --no-save --prefix . playwright-core
node collect.js ..\..\data\venues\alobo-hcm.json                    # cả 11 môn
node collect.js ..\..\data\venues\alobo-hcm.json "Cầu lông" "Padel" # chỉ vài môn
```

Tên môn viết đúng như trên trang: `Pickleball`, `Cầu lông`, `Bóng đá`, `Bóng rổ`, `Quần vợt`, `Đa năng`, `Typti`, `Lướt ván`, `B.Chuyền`, `Golf`, `Padel`.

| Biến môi trường | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PER_SPORT` | `10` | Số sân lấy cho mỗi môn (các sân gần tâm nhất) |
| `CENTER` | `10.7769,106.7009` | Vĩ độ, kinh độ làm tâm tìm kiếm (trung tâm TP.HCM) |
| `VIEW_HEIGHT` | `2800` | Chiều cao trang; bảng giá dài cần trang đủ cao để hiện hết |
| `HOME_WAIT` | `8000` | Số mili giây chờ trang chủ tải xong trước khi mở bộ lọc |

Kết quả ghi dần vào file đích nên có thể dừng giữa chừng: chạy lại sẽ bỏ qua môn đã xong và sân đã đọc. Muốn đọc lại một môn, xóa mục của môn đó trong `bySport` và các sân tương ứng trong `venues`; muốn lấy lại từ đầu thì xóa file. Chạy quá 10 phút nên khởi động ở một cửa sổ terminal riêng.

Sau khi thu thập, nhập vào database bằng `npm.cmd run db:import-venues -- data/venues/alobo-hcm.json` (xem README của backend).

## Dữ liệu mỗi sân

`slug`, `name`, `address`, `hours`, `sports` (các môn sân đăng ký), `location` (tọa độ từ nút Map), `rating`, `reviewCount`, `bookingUrl`, `priceTables` (mỗi bảng giá: `group` là loại sân, `name` là tên bảng giá, `columns`, `rows` theo ngày và khung giờ với giá cố định, giá vãng lai và đơn vị ca nếu có), `services`, `cover`, `avatar`, `yardDiagram`, `gallery` (URL ảnh), `rules`.

`pricesPartial: true` nghĩa là bảng giá dài hơn trang nên chưa đọc hết; tăng `VIEW_HEIGHT` rồi đọc lại sân đó.

## Khi trang đổi giao diện

Công cụ dựa vào nhãn và vị trí trên trang (`Tìm kiếm`, `Môn thể thao`, `Dịch vụ`, `BẢNG GIÁ SÂN`, nút lọc ở góc phải trên). Nếu log báo `sport chip not found` hoặc `side panel did not show the booking link`, giao diện đã thay đổi và cần chỉnh lại các nhãn hoặc tọa độ trong `collect.js`. Đặt `DEBUG_NODES=1` để in các ô đọc được ở tab bảng giá.
