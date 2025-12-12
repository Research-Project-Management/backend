# Hướng Dẫn Sử Dụng API Routes

## Mục Lục

- [1. Authentication Routes](#1-authentication-routes)
- [2. Workspace Routes](#2-workspace-routes)
- [3. Project Routes](#3-project-routes)

---

## 1. Authentication Routes

Base path: `/auth`

### 1.1 Lấy thông tin user hiện tại

```
GET /auth/user
```

**Response:**

- `200`: Trả về thông tin user đang đăng nhập
  ```json
  { "user": { ... } }
  ```
- `401`: Chưa đăng nhập
  ```json
  { "error": "null" }
  ```

---

### 1.2 Đăng nhập

```
POST /auth/login
```

**Body:**

```json
{
  "email": "string",
  "password": "string"
}
```

**Response:**

- `200`: Đăng nhập thành công
  ```json
  { "user": { ... } }
  ```
- `500`: Lỗi xác thực
  ```json
  { "type": "NULL_TYPE", "error": "..." }
  ```

---

### 1.3 Đăng ký

```
POST /auth/register
```

**Body:**

```json
{
  "name": "string",
  "email": "string",
  "password": "string"
}
```

**Response:**

- `200`: Đăng ký thành công, trả về thông tin user
- `400`: Thiếu thông tin hoặc email đã tồn tại
  ```json
  { "type": "EMAIL_HAD_ALREADY_TO_USE", "error": "Please use orther email" }
  ```

---

### 1.4 Đăng nhập qua GitHub

```
GET /auth/github
```

Redirect đến trang đăng nhập GitHub. Sau khi xác thực thành công, redirect về `CLIENT_URL/callback`.

---

### 1.5 Đăng nhập qua Google

```
GET /auth/google
```

Redirect đến trang đăng nhập Google. Sau khi xác thực thành công, redirect về `CLIENT_URL/callback`.

---

### 1.6 Đăng xuất

```
GET /auth/logout
```

**Response:**

- `200`: Đăng xuất thành công
  ```json
  { "message": "Logged out successfully" }
  ```

---

## 2. Workspace Routes

Base path: `/api`

> **Yêu cầu xác thực:** Tất cả các route đều yêu cầu đăng nhập (isAuthenticated)

### Các Role trong Workspace

| Role     | Quyền hạn                          |
| -------- | ---------------------------------- |
| `owner`  | Toàn quyền, có thể xóa workspace   |
| `admin`  | Quản lý workspace, thêm/xóa member |
| `member` | Xem workspace và tham gia project  |

---

### 2.1 Lấy tất cả workspace của user

```
GET /api/workspace
```

**Response:**

```json
{
  "workspaces": [...]
}
```

---

### 2.2 Tạo workspace mới

```
POST /api/workspace
```

**Body:**

```json
{
  "name": "string"
}
```

**Response:**

- `201`: Tạo thành công, user là owner
  ```json
  { "workspace": { ... } }
  ```

---

### 2.3 Lấy chi tiết workspace

```
GET /api/workspace/:id
```

**Quyền:** `owner`, `admin`, `member`

**Response:**

```json
{
  "workspace": { ... },
  "yourRole": "member"
}
```

---

### 2.4 Cập nhật workspace

```
PUT /api/workspace/:id
```

**Quyền:** `owner`, `admin`

**Body:**

```json
{
  "name": "string"
}
```

**Response:**

```json
{ "workspace": { ... } }
```

---

### 2.5 Thêm member vào workspace

```
PUT /api/workspace/:id/add-member
```

**Quyền:** `owner`, `admin`

**Body:**

```json
{
  "userId": "string",
  "role": "member" // "owner" | "admin" | "member" (mặc định: "member")
}
```

**Lưu ý:**

- Admin không thể thêm role `owner` hoặc `admin`

**Response:**

```json
{ "workspace": { ... } }
```

**Lỗi:**

- `400`: User đã là member
- `403`: Admin không có quyền thêm owner/admin

---

### 2.6 Cập nhật role member

```
PUT /api/workspace/:id/update-member-role
```

**Quyền:** `owner`, `admin`

**Body:**

```json
{
  "userId": "string",
  "newRole": "admin" // "owner" | "admin" | "member"
}
```

**Lưu ý:**

- Chỉ owner mới có thể đổi role thành `admin` hoặc `owner`

**Response:**

```json
{ "workspace": { ... } }
```

**Lỗi:**

- `403`: Không có quyền thay đổi role
- `404`: Member không tồn tại

---

### 2.7 Xóa member khỏi workspace

```
PUT /api/workspace/:id/remove-member
```

**Quyền:** `owner`, `admin`

**Body:**

```json
{
  "userId": "string"
}
```

**Lưu ý:**

- Không thể xóa owner
- Admin không thể xóa admin khác

**Response:**

```json
{ "workspace": { ... } }
```

**Lỗi:**

- `403`: Không có quyền xóa member này
- `404`: Member không tồn tại

---

### 2.8 Xóa workspace

```
DELETE /api/workspace/:id
```

**Quyền:** Chỉ `owner`

**Response:**

- `204`: Xóa thành công (no content)

---

## 3. Project Routes

Base path: `/api`

> **Yêu cầu xác thực:** Tất cả các route đều yêu cầu đăng nhập (isAuthenticated)

### Các Role trong Project

| Role      | Quyền hạn                                |
| --------- | ---------------------------------------- |
| `manager` | Toàn quyền trong project, quản lý member |
| `member`  | Tham gia project, xem chi tiết           |
| `viewer`  | Chỉ xem project                          |

---

### 3.1 Lấy tất cả project trong workspace

```
GET /api/workspace/:id/projects
```

**Quyền:** `owner`, `admin`, `member` của workspace

**Lưu ý:**

- Workspace owner/admin thấy tất cả project
- Member chỉ thấy project mình tham gia

**Response:**

```json
{
  "projects": [...]
}
```

---

### 3.2 Tạo project mới

```
POST /api/workspace/:id/projects
```

**Quyền:** `owner`, `admin` của workspace

**Body:**

```json
{
  "title": "string",
  "description": "string"
}
```

**Response:**

- `201`: Tạo thành công, user là manager của project
  ```json
  { "project": { ... } }
  ```

---

### 3.3 Lấy chi tiết project

```
GET /api/project/:projectId
```

**Quyền:** `manager`, `member`, `viewer` của project hoặc `admin`/`owner` của workspace

**Response:**

```json
{
  "project": { ... },
  "yourRole": "manager"
}
```

---

### 3.4 Cập nhật project

```
PUT /api/project/:projectId
```

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

```json
{
  "title": "string",
  "description": "string"
}
```

**Response:**

```json
{ "project": { ... } }
```

---

### 3.5 Xóa project

```
DELETE /api/project/:projectId
```

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Response:**

- `204`: Xóa thành công (no content)

---

### 3.6 Thêm member vào project

```
PUT /api/project/:projectId/add-member
```

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

```json
{
  "userId": "string",
  "role": "member" // "manager" | "member" | "viewer" (mặc định: "member")
}
```

**Lưu ý:**

- User phải là member của workspace trước

**Response:**

```json
{ "project": { ... } }
```

**Lỗi:**

- `400`: User không thuộc workspace hoặc đã là member của project

---

### 3.7 Cập nhật role member trong project

```
PUT /api/project/:projectId/update-member-role
```

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

```json
{
  "userId": "string",
  "newRole": "member" // "manager" | "member" | "viewer"
}
```

**Lưu ý:**

- Không thể thay đổi role của chính mình

**Response:**

```json
{ "project": { ... } }
```

**Lỗi:**

- `400`: Không thể thay đổi role chính mình
- `404`: Member không tồn tại trong project

---

### 3.8 Xóa member khỏi project

```
PUT /api/project/:projectId/remove-member
```

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

```json
{
  "userId": "string"
}
```

**Lưu ý:**

- Không thể xóa chính mình (dùng route leave)
- Không thể xóa manager nếu không phải workspace admin/owner

**Response:**

```json
{ "project": { ... } }
```

**Lỗi:**

- `400`: Không thể xóa chính mình
- `403`: Không có quyền xóa manager
- `404`: Member không tồn tại trong project

---

### 3.9 Rời khỏi project

```
PUT /api/project/:projectId/leave
```

**Quyền:** `manager`, `member`, `viewer` của project

**Lưu ý:**

- Nếu là manager duy nhất, phải chuyển quyền cho người khác trước khi rời

**Response:**

```json
{ "message": "Left project successfully" }
```

**Lỗi:**

- `400`: Là manager duy nhất, không thể rời
- `404`: Không phải member của project

---

## Mã Lỗi Phổ Biến

| Status Code | Mô tả                                 |
| ----------- | ------------------------------------- |
| `200`       | Thành công                            |
| `201`       | Tạo mới thành công                    |
| `204`       | Xóa thành công (no content)           |
| `400`       | Bad Request - Dữ liệu không hợp lệ    |
| `401`       | Unauthorized - Chưa đăng nhập         |
| `403`       | Forbidden - Không có quyền truy cập   |
| `404`       | Not Found - Không tìm thấy tài nguyên |
| `500`       | Internal Server Error - Lỗi server    |

---

## Ghi Chú

1. Tất cả các request cần gửi cookie session để xác thực
2. Các route có `:id` hoặc `:projectId` cần thay bằng MongoDB ObjectId thực tế
3. Role trong workspace và project là độc lập với nhau
4. Workspace admin/owner có quyền cao hơn trong các project thuộc workspace đó
