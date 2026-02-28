# Docker Setup - RPM Backend

Hướng dẫn setup và chạy project RPM Backend với Docker.

## 📋 Yêu cầu

- Docker Desktop hoặc Docker Engine
- Docker Compose v3.8+

## 🚀 Cách sử dụng

### 1. Tạo file `.env`

Copy file `.env.example` thành `.env` và cấu hình các biến môi trường:

```bash
cp .env.example .env
```

Chỉnh sửa file `.env` với thông tin của bạn (đặc biệt là SESSION_SECRET trong production).

### 2. Khởi động services

**Development mode với hot-reload:**

```bash
docker-compose up
```

**Chạy ở background:**

```bash
docker-compose up -d
```

### 3. Kiểm tra logs

```bash
# Xem tất cả logs
docker-compose logs -f

# Xem logs của service cụ thể
docker-compose logs -f app
docker-compose logs -f mongodb
docker-compose logs -f redis
```

### 4. Dừng services

```bash
docker-compose down
```

**Xóa cả volumes (database data):**

```bash
docker-compose down -v
```

## 🔧 Services

Project bao gồm 2 services:

### 1. **Redis** (Cache & Session Store)

- Port: `6379`
- Sử dụng Redis server có sẵn (không chạy container)

### 2. **Backend App** (Node.js/Express)

- Port: `3000` (có thể thay đổi trong `.env`)
- Container: `rpm-backend`
- Hot-reload enabled (development)

**Lưu ý:** MongoDB không chạy trong Docker mà sử dụng server MongoDB có sẵn. Cấu hình kết nối MongoDB trong file `.env`.

## 📦 Build lại image

Nếu bạn thay đổi dependencies trong `package.json`:

```bash
docker-compose up --build
```

Hoặc build riêng:

```bash
docker-compose build app
```

## 🔍 Debug

### Truy cập vào container

```bash
# Backend app
docker exec -it rpm-backend sh

# Redis
docker exec -it rpm-redis redis-cli
```

### Kiểm tra health status

```bash
docker-compose ps
```

### Redis CLI

Kết nối tới Redis:

```bash
docker exec -it rpm-redis redis-cli
```

## 🛠 Troubleshooting

### Lỗi port đã được sử dụng

Thay đổi port mapping trong file `.env` hoặc `docker-compose.yml`.

### Lỗi permission denied

Chạy Docker với quyền administrator hoặc thêm user vào docker group (Linux).

### Container không khởi động

```bash
# Kiểm tra logs
docker-compose logs app

# Xóa containers và volumes cũ
docker-compose down -v
docker-compose up --build
```

### Reset toàn bộ

```bash
# Dừng và xóa tất cả
docker-compose down -v

# Xóa images
docker rmi rpm-backend

# Khởi động lại
docker-compose up --build
```

## 📝 Notes

- Development mode: Code được mount vào container, thay đổi code sẽ tự động reload (nếu dùng nodemon hoặc watch mode)
- Production: Nên build image riêng và không mount source code
- Database data được lưu trong Docker volumes, không mất khi restart containers
- Thay đổi `SESSION_SECRET` và các credentials trong production

## 🔐 Security

**QUAN TRỌNG:** Trong production:

1. Thay đổi `SESSION_SECRET` thành giá trị random mạnh
2. Đảm bảo MongoDB server có authentication và firewall rules phù hợp
3. Không expose ports không cần thiết
4. Sử dụng secrets management (Docker secrets, Azure Key Vault, AWS Secrets Manager, etc.)
5. Enable SSL/TLS cho MongoDB và Redis nếu cần

## 📚 Tham khảo thêm

- [Docker Documentation](https://docs.docker.com/)
- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Redis Docker Hub](https://hub.docker.com/_/redis)
- [MongoDB Documentation](https://www.mongodb.com/docs/)
