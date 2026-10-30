# Ứng dụng quản lý công việc PWA

Ứng dụng quản lý công việc có thể lưu dữ liệu trên thiết bị khi offline và đồng bộ lên MariaDB/MySQL khi có kết nối mạng.

## Yêu cầu

- Node.js 20 trở lên và npm.
- MySQL hoặc MariaDB đang chạy.
- Trình duyệt hiện đại. Nên dùng Chrome hoặc Edge trên Android và Safari trên iPhone.

## Cài đặt

Mở PowerShell tại thư mục dự án, cài dependencies cho cả backend và frontend:

```powershell
cd backend
npm install
cd ..\frontend
npm install
cd ..
```

## Cấu hình database

Tạo database trong MySQL/MariaDB, ví dụ:

```sql
CREATE DATABASE pwa_offline
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

Tạo file `backend/.env` với thông tin kết nối của máy bạn:

```dotenv
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=mat_khau_database_cua_ban
DB_NAME=pwa_offline
DB_PORT=3306
PORT=3000
```

Thay user và mật khẩu mẫu bằng thông tin thật. **Không commit hoặc chia sẻ `backend/.env`**; file này đã được Git bỏ qua.

Khi backend khởi động, ứng dụng tự tạo/kiểm tra các bảng `nguoi_dung`, `phien_dang_nhap` và `cong_viec_dong_bo`. Công việc của ứng dụng được đồng bộ vào `cong_viec_dong_bo`; bảng `cong_viec` cũ không được sử dụng.

## Chạy ứng dụng trên máy tính

Mở hai cửa sổ PowerShell tại thư mục dự án.

Cửa sổ 1 — backend:

```powershell
cd backend
npm run dev
```

Cửa sổ 2 — frontend:

```powershell
cd frontend
npm start
```

Mở frontend tại <http://localhost:5500>. Có thể kiểm tra backend tại <http://localhost:3000/> và kiểm tra database tại <http://localhost:3000/api/test-db>.

Frontend gọi API backend ở cùng hostname trên cổng `3000`; giữ frontend ở cổng `5500` và backend ở cổng `3000`, trừ khi cập nhật cấu hình tương ứng trong mã nguồn.

## Mở trên điện thoại cùng Wi-Fi

1. Kết nối điện thoại và máy tính vào cùng một mạng Wi-Fi.
2. Tìm địa chỉ IPv4 Wi-Fi của máy tính. Trên Windows, chạy `ipconfig` và xem dòng **IPv4 Address** ở adapter Wi-Fi.
3. Mở `http://<IPv4-của-máy-tính>:5500` trên điện thoại, ví dụ `http://192.168.1.2:5500`.
4. Nếu không kết nối được, kiểm tra Windows Firewall cho phép Node.js/cổng `5500` và `3000` trên mạng riêng đáng tin cậy. Không mở các cổng này ra Internet công cộng.

Truy cập LAN bằng HTTP phù hợp để thử giao diện và chức năng online. Trình duyệt thường yêu cầu **HTTPS** để cài PWA đầy đủ và bật Service Worker/offline trên điện thoại. Để phát hành sử dụng thực tế, hãy triển khai website bằng HTTPS và cấu hình backend/API có thể truy cập qua HTTPS.

## Sử dụng offline và đồng bộ

- Sau khi đăng nhập, công việc được lưu cục bộ trong IndexedDB của trình duyệt (`PWA_QuanLy`).
- Các thay đổi chờ gửi được giữ trong hàng đợi đồng bộ trên thiết bị.
- Khi có mạng và kết nối backend, ứng dụng đồng bộ công việc lên bảng `cong_viec_dong_bo`.
- Trước khi xóa dữ liệu trình duyệt hoặc gỡ ứng dụng, hãy chắc chắn các thay đổi đã đồng bộ. Dữ liệu chưa đồng bộ chỉ nằm trên thiết bị đó.

## Cài lên màn hình chính

- **Android:** mở ứng dụng bằng Chrome; dùng menu trình duyệt và chọn **Cài đặt ứng dụng** hoặc **Thêm vào màn hình chính**.
- **iPhone:** mở bằng Safari, nhấn **Chia sẻ**, rồi chọn **Thêm vào Màn hình chính**.

Để có trải nghiệm PWA/offline đầy đủ trên điện thoại, website cần được phục vụ qua HTTPS.

## Cấu trúc chính

```text
backend/
  config/          Kết nối MySQL/MariaDB
  controllers/     Xử lý tài khoản và đồng bộ công việc
  middleware/      Xác thực phiên đăng nhập
  routes/          API auth và tasks
  server.js        Khởi tạo Express và schema database
frontend/
  index.html       Tổng quan
  add.html         Thêm công việc
  tasks.html       Danh sách công việc
  sync.html        Trạng thái đồng bộ
  js/              Logic giao diện và IndexedDB
  service-worker.js Cache và hỗ trợ offline
  manifest.json    Cấu hình PWA và biểu tượng
```
