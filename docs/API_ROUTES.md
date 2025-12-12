# Hướng Dẫn Sử Dụng API Routes

## Mục Lục

- [1. Authentication Routes](#1-authentication-routes)
- [2. Workspace Routes](#2-workspace-routes)
- [3. Project Routes](#3-project-routes)
- [4. File Routes](#4-file-routes)
- [5. Data Types](#5-data-types)

---

## 5. Data Types

### User Object

| Field       | Type      | Description                |
| ----------- | --------- | -------------------------- |
| `_id`       | `ObjectId`| ID của user                |
| `email`     | `String`  | Email (unique)             |
| `password`  | `String`  | Password đã hash (nullable)|
| `name`      | `String`  | Tên user (default: "User") |
| `avatar`    | `String`  | URL avatar (nullable)      |
| `isVerified`| `Boolean` | Đã xác thực chưa           |
| `googleId`  | `String`  | Google OAuth ID (nullable) |
| `githubId`  | `String`  | GitHub OAuth ID (nullable) |
| `createdAt` | `Date`    | Ngày tạo                   |
| `updatedAt` | `Date`    | Ngày cập nhật              |

### Workspace Object

| Field       | Type                    | Description                    |
| ----------- | ----------------------- | ------------------------------ |
| `_id`       | `ObjectId`              | ID của workspace               |
| `name`      | `String`                | Tên workspace (required)       |
| `color`     | `String`                | Màu sắc (default: "#1e2939")   |
| `avatar`    | `String`                | URL avatar (nullable)          |
| `members`   | `WorkspaceMember[]`     | Danh sách member               |
| `createdBy` | `ObjectId` (ref: User)  | User tạo workspace             |
| `settings`  | `Mixed`                 | Cài đặt workspace (default: {})|
| `createdAt` | `Date`                  | Ngày tạo                       |
| `updatedAt` | `Date`                  | Ngày cập nhật                  |

### WorkspaceMember Object

| Field     | Type                   | Description                              |
| --------- | ---------------------- | ---------------------------------------- |
| `user`    | `ObjectId` (ref: User) | ID của user                              |
| `role`    | `String`               | `"owner"` \| `"admin"` \| `"member"`     |
| `joinedAt`| `Date`                 | Ngày tham gia (default: Date.now)        |

### Project Object

| Field       | Type                        | Description                    |
| ----------- | --------------------------- | ------------------------------ |
| `_id`       | `ObjectId`                  | ID của project                 |
| `isActive`  | `Boolean`                   | Trạng thái (default: true)     |
| `title`     | `String`                    | Tiêu đề project (required)     |
| `description`| `String`                   | Mô tả (default: "")            |
| `members`   | `ProjectMember[]`           | Danh sách member               |
| `workspace` | `ObjectId` (ref: Workspace) | ID workspace chứa project      |
| `createdBy` | `ObjectId` (ref: User)      | User tạo project               |
| `settings`  | `Mixed`                     | Cài đặt project (default: {})  |
| `createdAt` | `Date`                      | Ngày tạo                       |
| `updatedAt` | `Date`                      | Ngày cập nhật                  |

### ProjectMember Object

| Field     | Type                   | Description                                   |
| --------- | ---------------------- | --------------------------------------------- |
| `user`    | `ObjectId` (ref: User) | ID của user                                   |
| `role`    | `String`               | `"manager"` \| `"member"` \| `"viewer"`       |
| `joinedAt`| `Date`                 | Ngày tham gia (default: Date.now)             |

### File Object

| Field       | Type                        | Description                    |
| ----------- | --------------------------- | ------------------------------ |
| `_id`       | `ObjectId`                  | ID của file                    |
| `filename`  | `String`                    | Tên file (required)            |
| `author`    | `ObjectId` (ref: User)      | User upload file               |
| `workspace` | `ObjectId` (ref: Workspace) | Workspace chứa file (nullable) |
| `project`   | `ObjectId` (ref: Project)   | Project chứa file (nullable)   |
| `uploadedAt`| `Date`                      | Ngày upload (default: Date.now)|
| `size`      | `Number`                    | Kích thước file (bytes)        |
| `mimeType`  | `String`                    | MIME type của file             |
| `url`       | `String`                    | URL của file                   |
| `createdAt` | `Date`                      | Ngày tạo                       |
| `updatedAt` | `Date`                      | Ngày cập nhật                  |

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
  {
    "user": {
      "_id": "ObjectId",
      "email": "String",
      "name": "String",
      "avatar": "String | null",
      "isVerified": "Boolean",
      "googleId": "String | null",
      "githubId": "String | null",
      "createdAt": "Date",
      "updatedAt": "Date"
    }
  }
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

| Field      | Type     | Required | Description      |
| ---------- | -------- | -------- | ---------------- |
| `email`    | `String` | ✅       | Email đăng nhập  |
| `password` | `String` | ✅       | Mật khẩu         |

```json
{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

**Response:**

- `200`: Đăng nhập thành công
  ```json
  {
    "user": {
      "_id": "ObjectId",
      "email": "String",
      "name": "String",
      "avatar": "String | null",
      "isVerified": "Boolean",
      "createdAt": "Date",
      "updatedAt": "Date"
    }
  }
  ```
- `500`: Lỗi xác thực
  ```json
  {
    "type": "String",
    "error": "String"
  }
  ```

---

### 1.3 Đăng ký

```
POST /auth/register
```

**Body:**

| Field      | Type     | Required | Description      |
| ---------- | -------- | -------- | ---------------- |
| `name`     | `String` | ✅       | Tên người dùng   |
| `email`    | `String` | ✅       | Email đăng ký    |
| `password` | `String` | ✅       | Mật khẩu         |

```json
{
  "name": "John Doe",
  "email": "user@example.com",
  "password": "yourpassword"
}
```

**Response:**

- `200`: Đăng ký thành công
  ```json
  {
    "_id": "ObjectId",
    "email": "String",
    "name": "String",
    "avatar": "null",
    "isVerified": false,
    "googleId": "null",
    "githubId": "null",
    "createdAt": "Date",
    "updatedAt": "Date"
  }
  ```
- `400`: Thiếu thông tin hoặc email đã tồn tại
  ```json
  {
    "type": "EMAIL_HAD_ALREADY_TO_USE",
    "error": "Please use orther email"
  }
  ```
  hoặc
  ```json
  {
    "error": "Missing required fields"
  }
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
  {
    "message": "Logged out successfully"
  }
  ```

---

## 2. Workspace Routes

Base path: `/api/workspace`

> **Yêu cầu xác thực:** Tất cả các route đều yêu cầu đăng nhập (isAuthenticated)

### Các Role trong Workspace

| Role     | Giá trị    | Quyền hạn                          |
| -------- | ---------- | ---------------------------------- |
| `owner`  | `"owner"`  | Toàn quyền, có thể xóa workspace   |
| `admin`  | `"admin"`  | Quản lý workspace, thêm/xóa member |
| `member` | `"member"` | Xem workspace và tham gia project  |

---

### 2.1 Lấy tất cả workspace của user

```
GET /api/workspace
```

**Response:**

- `200`: Thành công
  ```json
  {
    "workspaces": [
      {
        "_id": "ObjectId",
        "name": "String",
        "color": "String",
        "avatar": "String | null",
        "members": [
          {
            "user": "ObjectId",
            "role": "owner | admin | member",
            "joinedAt": "Date"
          }
        ],
        "createdBy": "ObjectId",
        "settings": {},
        "createdAt": "Date",
        "updatedAt": "Date"
      }
    ]
  }
  ```

---

### 2.2 Tạo workspace mới

```
POST /api/workspace
```

**Body:**

| Field    | Type     | Required | Default       | Description         |
| -------- | -------- | -------- | ------------- | ------------------- |
| `name`   | `String` | ✅       | -             | Tên workspace       |
| `color`  | `String` | ❌       | `"#1e2939"`   | Màu sắc workspace   |
| `avatar` | `String` | ❌       | `null`        | URL avatar          |

```json
{
  "name": "My Workspace",
  "color": "#3b82f6",
  "avatar": "https://example.com/avatar.png"
}
```

**Response:**

- `201`: Tạo thành công, user là owner
  ```json
  {
    "workspace": {
      "_id": "ObjectId",
      "name": "String",
      "color": "String",
      "avatar": "String | null",
      "members": [
        {
          "user": "ObjectId",
          "role": "owner",
          "joinedAt": "Date"
        }
      ],
      "createdBy": "ObjectId",
      "settings": {},
      "createdAt": "Date",
      "updatedAt": "Date"
    }
  }
  ```

---

### 2.3 Lấy chi tiết workspace

```
GET /api/workspace/:id
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`, `member`

**Response:**

- `200`: Thành công
  ```json
  {
    "workspace": {
      "_id": "ObjectId",
      "name": "String",
      "color": "String",
      "avatar": "String | null",
      "members": [
        {
          "user": {
            "_id": "ObjectId",
            "name": "String",
            "email": "String",
            "avatar": "String | null"
          },
          "role": "owner | admin | member",
          "joinedAt": "Date"
        }
      ],
      "createdBy": "ObjectId",
      "settings": {},
      "createdAt": "Date",
      "updatedAt": "Date"
    },
    "yourRole": "owner | admin | member"
  }
  ```

---

### 2.4 Cập nhật workspace

```
PUT /api/workspace/:id
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`

**Body:**

| Field  | Type     | Required | Description      |
| ------ | -------- | -------- | ---------------- |
| `name` | `String` | ❌       | Tên workspace mới|

```json
{
  "name": "Updated Workspace Name"
}
```

**Response:**

- `200`: Thành công
  ```json
  {
    "workspace": {
      "_id": "ObjectId",
      "name": "String",
      "color": "String",
      "avatar": "String | null",
      "members": [...],
      "createdBy": "ObjectId",
      "settings": {},
      "createdAt": "Date",
      "updatedAt": "Date"
    }
  }
  ```

---

### 2.5 Thêm member vào workspace

```
PUT /api/workspace/:id/add-member
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`

**Body:**

| Field    | Type       | Required | Default    | Description                              |
| -------- | ---------- | -------- | ---------- | ---------------------------------------- |
| `userId` | `ObjectId` | ✅       | -          | ID của user cần thêm                     |
| `role`   | `String`   | ❌       | `"member"` | `"owner"` \| `"admin"` \| `"member"`     |

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "role": "member"
}
```

**Lưu ý:**

- Admin không thể thêm role `owner` hoặc `admin`

**Response:**

- `200`: Thành công
  ```json
  {
    "workspace": {...}
  }
  ```

**Lỗi:**

- `400`: User đã là member
  ```json
  { "error": "User already a member" }
  ```
- `403`: Admin không có quyền thêm owner/admin
  ```json
  { "error": "Cannot add owner or admin" }
  ```

---

### 2.6 Cập nhật role member

```
PUT /api/workspace/:id/update-member-role
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`

**Body:**

| Field     | Type       | Required | Description                              |
| --------- | ---------- | -------- | ---------------------------------------- |
| `userId`  | `ObjectId` | ✅       | ID của user cần cập nhật                 |
| `newRole` | `String`   | ✅       | `"owner"` \| `"admin"` \| `"member"`     |

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "newRole": "admin"
}
```

**Lưu ý:**

- Chỉ owner mới có thể đổi role thành `admin` hoặc `owner`

**Response:**

- `200`: Thành công
  ```json
  {
    "workspace": {...}
  }
  ```

**Lỗi:**

- `403`: Không có quyền thay đổi role
  ```json
  { "error": "Only owner can assign admin/owner role" }
  ```
- `404`: Member không tồn tại
  ```json
  { "error": "Member not found" }
  ```

---

### 2.7 Xóa member khỏi workspace

```
PUT /api/workspace/:id/remove-member
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`

**Body:**

| Field    | Type       | Required | Description          |
| -------- | ---------- | -------- | -------------------- |
| `userId` | `ObjectId` | ✅       | ID của user cần xóa  |

```json
{
  "userId": "507f1f77bcf86cd799439011"
}
```

**Lưu ý:**

- Không thể xóa owner
- Admin không thể xóa admin khác

**Response:**

- `200`: Thành công
  ```json
  {
    "workspace": {...}
  }
  ```

**Lỗi:**

- `403`: Không có quyền xóa member này
  ```json
  { "error": "Cannot remove owner" }
  ```
  hoặc
  ```json
  { "error": "Admin cannot remove another admin" }
  ```
- `404`: Member không tồn tại
  ```json
  { "error": "Member not found" }
  ```

---

### 2.8 Xóa workspace

```
DELETE /api/workspace/:id
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** Chỉ `owner`

**Response:**

- `204`: Xóa thành công (no content)

---

## 3. Project Routes

Base path: `/api`

> **Yêu cầu xác thực:** Tất cả các route đều yêu cầu đăng nhập (isAuthenticated)

### Các Role trong Project

| Role      | Giá trị     | Quyền hạn                                |
| --------- | ----------- | ---------------------------------------- |
| `manager` | `"manager"` | Toàn quyền trong project, quản lý member |
| `member`  | `"member"`  | Tham gia project, xem chi tiết           |
| `viewer`  | `"viewer"`  | Chỉ xem project                          |

---

### 3.1 Lấy tất cả project trong workspace

```
GET /api/workspace/:id/projects
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin`, `member` của workspace

**Lưu ý:**

- Workspace owner/admin thấy tất cả project
- Member chỉ thấy project mình tham gia

**Response:**

- `200`: Thành công
  ```json
  {
    "projects": [
      {
        "_id": "ObjectId",
        "isActive": true,
        "title": "String",
        "description": "String",
        "members": [
          {
            "user": {
              "_id": "ObjectId",
              "name": "String",
              "email": "String"
            },
            "role": "manager | member | viewer",
            "joinedAt": "Date"
          }
        ],
        "workspace": "ObjectId",
        "createdBy": "ObjectId",
        "settings": {},
        "createdAt": "Date",
        "updatedAt": "Date"
      }
    ]
  }
  ```

---

### 3.2 Tạo project mới

```
POST /api/workspace/:id/projects
```

**Params:**

| Param | Type       | Description      |
| ----- | ---------- | ---------------- |
| `id`  | `ObjectId` | ID của workspace |

**Quyền:** `owner`, `admin` của workspace

**Body:**

| Field         | Type     | Required | Default | Description       |
| ------------- | -------- | -------- | ------- | ----------------- |
| `title`       | `String` | ✅       | -       | Tiêu đề project   |
| `description` | `String` | ❌       | `""`    | Mô tả project     |

```json
{
  "title": "New Project",
  "description": "Project description"
}
```

**Response:**

- `201`: Tạo thành công, user là manager của project
  ```json
  {
    "project": {
      "_id": "ObjectId",
      "isActive": true,
      "title": "String",
      "description": "String",
      "members": [
        {
          "user": "ObjectId",
          "role": "manager",
          "joinedAt": "Date"
        }
      ],
      "workspace": "ObjectId",
      "createdBy": "ObjectId",
      "settings": {},
      "createdAt": "Date",
      "updatedAt": "Date"
    }
  }
  ```

---

### 3.3 Lấy chi tiết project

```
GET /api/project/:projectId
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager`, `member`, `viewer` của project hoặc `admin`/`owner` của workspace

**Response:**

- `200`: Thành công
  ```json
  {
    "project": {
      "_id": "ObjectId",
      "isActive": true,
      "title": "String",
      "description": "String",
      "members": [
        {
          "user": {
            "_id": "ObjectId",
            "name": "String",
            "email": "String"
          },
          "role": "manager | member | viewer",
          "joinedAt": "Date"
        }
      ],
      "workspace": "ObjectId",
      "createdBy": "ObjectId",
      "settings": {},
      "createdAt": "Date",
      "updatedAt": "Date"
    },
    "yourRole": "manager | member | viewer"
  }
  ```

---

### 3.4 Cập nhật project

```
PUT /api/project/:projectId
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

| Field         | Type     | Required | Description        |
| ------------- | -------- | -------- | ------------------ |
| `title`       | `String` | ❌       | Tiêu đề mới        |
| `description` | `String` | ❌       | Mô tả mới          |

```json
{
  "title": "Updated Project Title",
  "description": "Updated description"
}
```

**Response:**

- `200`: Thành công
  ```json
  {
    "project": {...}
  }
  ```

---

### 3.5 Xóa project

```
DELETE /api/project/:projectId
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Response:**

- `204`: Xóa thành công (no content)

---

### 3.6 Thêm member vào project

```
PUT /api/project/:projectId/add-member
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

| Field    | Type       | Required | Default    | Description                                 |
| -------- | ---------- | -------- | ---------- | ------------------------------------------- |
| `userId` | `ObjectId` | ✅       | -          | ID của user cần thêm                        |
| `role`   | `String`   | ❌       | `"member"` | `"manager"` \| `"member"` \| `"viewer"`     |

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "role": "member"
}
```

**Lưu ý:**

- User phải là member của workspace trước

**Response:**

- `200`: Thành công
  ```json
  {
    "project": {...}
  }
  ```

**Lỗi:**

- `400`: User không thuộc workspace hoặc đã là member của project
  ```json
  { "error": "User is not a member of this workspace" }
  ```
  hoặc
  ```json
  { "error": "User is already a member of this project" }
  ```

---

### 3.7 Cập nhật role member trong project

```
PUT /api/project/:projectId/update-member-role
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

| Field     | Type       | Required | Description                                 |
| --------- | ---------- | -------- | ------------------------------------------- |
| `userId`  | `ObjectId` | ✅       | ID của user cần cập nhật                    |
| `newRole` | `String`   | ✅       | `"manager"` \| `"member"` \| `"viewer"`     |

```json
{
  "userId": "507f1f77bcf86cd799439011",
  "newRole": "manager"
}
```

**Lưu ý:**

- Không thể thay đổi role của chính mình

**Response:**

- `200`: Thành công
  ```json
  {
    "project": {...}
  }
  ```

**Lỗi:**

- `400`: Không thể thay đổi role chính mình
  ```json
  { "error": "Cannot change your own role" }
  ```
- `404`: Member không tồn tại trong project
  ```json
  { "error": "Member not found in project" }
  ```

---

### 3.8 Xóa member khỏi project

```
PUT /api/project/:projectId/remove-member
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager` của project hoặc `admin`/`owner` của workspace

**Body:**

| Field    | Type       | Required | Description          |
| -------- | ---------- | -------- | -------------------- |
| `userId` | `ObjectId` | ✅       | ID của user cần xóa  |

```json
{
  "userId": "507f1f77bcf86cd799439011"
}
```

**Lưu ý:**

- Không thể xóa chính mình (dùng route leave)
- Không thể xóa manager nếu không phải workspace admin/owner

**Response:**

- `200`: Thành công
  ```json
  {
    "project": {...}
  }
  ```

**Lỗi:**

- `400`: Không thể xóa chính mình
  ```json
  { "error": "Cannot remove yourself" }
  ```
- `403`: Không có quyền xóa manager
  ```json
  { "error": "Cannot remove a manager" }
  ```
- `404`: Member không tồn tại trong project
  ```json
  { "error": "Member not found in project" }
  ```

---

### 3.9 Rời khỏi project

```
PUT /api/project/:projectId/leave
```

**Params:**

| Param       | Type       | Description     |
| ----------- | ---------- | --------------- |
| `projectId` | `ObjectId` | ID của project  |

**Quyền:** `manager`, `member`, `viewer` của project

**Lưu ý:**

- Nếu là manager duy nhất, phải chuyển quyền cho người khác trước khi rời

**Response:**

- `200`: Thành công
  ```json
  {
    "message": "Left project successfully"
  }
  ```

**Lỗi:**

- `400`: Là manager duy nhất, không thể rời
  ```json
  {
    "error": "Cannot leave. You are the only manager. Transfer ownership first."
  }
  ```
- `404`: Không phải member của project
  ```json
  { "error": "You are not a member" }
  ```

---

## 4. File Routes

Base path: `/api/files`

### 4.1 Lấy Presigned URL để upload file

```
POST /api/files/presign
```

**Body:**

| Field         | Type     | Required | Description                   |
| ------------- | -------- | -------- | ----------------------------- |
| `filename`    | `String` | ✅       | Tên file cần upload           |
| `contentType` | `String` | ✅       | MIME type của file            |

```json
{
  "filename": "document.pdf",
  "contentType": "application/pdf"
}
```

**Response:**

- `200`: Thành công
  ```json
  {
    "url": "String (presigned URL, expires in 1 hour)"
  }
  ```
- `400`: Thiếu thông tin
  ```json
  { "error": "Missing required fields" }
  ```
- `500`: Lỗi server
  ```json
  { "error": "String" }
  ```

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
2. Các route có `:id` hoặc `:projectId` cần thay bằng MongoDB ObjectId thực tế (24 ký tự hex)
3. Role trong workspace và project là độc lập với nhau
4. Workspace admin/owner có quyền cao hơn trong các project thuộc workspace đó
5. Kiểu `ObjectId` là MongoDB ObjectId dạng string 24 ký tự hex (ví dụ: `"507f1f77bcf86cd799439011"`)
6. Kiểu `Date` là ISO 8601 date string (ví dụ: `"2025-12-12T10:30:00.000Z"`)
7. Kiểu `Mixed` là object tùy ý, có thể chứa bất kỳ dữ liệu nào
