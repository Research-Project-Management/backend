# Hướng Dẫn Kiểm Thử Backend (Backend Testing Architecture & Workflow Guide)

Tài liệu này quy chuẩn phương pháp viết và chạy test trong backend của dự án Flux, đảm bảo **tối ưu thời gian chạy (Fast Feedback Loop)** và **tránh lạm dụng quét toàn bộ hệ thống** gây lãng phí tài nguyên và làm chậm tốc độ phát triển.

---

## 1. Nguyên Tắc Cốt Lõi (Core Principles)

1. **Hermetic & Bounded-Context Testing**: 
   Khi phát triển một module (ví dụ: `work-item`, `library`, `manuscripts`), bạn **chỉ được và chỉ cần** chạy test của module đó.
2. **Không lạm dụng `pnpm test` ở Local**:
   Lệnh `pnpm test` quét toàn bộ hơn 96 file test trên toàn hệ thống (mất từ 3–5 phút). Chỉ chạy lệnh này trên môi trường CI/CD trước khi mở hoặc merge Pull Request.
3. **Living Documentation**:
   Thư mục test của mỗi module phản ánh chính xác các luồng nghiệp vụ của module đó.

---

## 2. Các Lệnh Chạy Test Chuẩn Theo Module (Scoped Commands)

Mọi lập trình viên khi làm việc tại module nào chỉ cần chạy script tương ứng:

| Module | Lệnh Test | Mục Tiêu & Phạm Vi |
| :--- | :--- | :--- |
| **Work-Item** | `pnpm test:work-item` | Tạo work-item, quan hệ quan hệ dependencies, attachments |
| **Library** | `pnpm test:library` | Zotero parity, BibTeX/CSL citation, OCR, ingestion saga |
| **Manuscripts** | `pnpm test:manuscripts` | Overleaf parity, CLSI compiler, Docstore, Realtime collaboration |
| **Storage** | `pnpm test:storage` | S3 presigned URLs, Multipart upload, lifecycle, cleanup |
| **Identity** | `pnpm test:identity` | User auth, permission, security facades, token claims |
| **AI** | `pnpm test:ai` | AI threads, semantic chunking, RAG ingestion |
| **Project** | `pnpm test:project` | Phân quyền truy cập dự án, trạng thái dự án, modules |
| **Analytics** | `pnpm test:analytics` | Dashboard Your-Work, hoạt động cá nhân, thống kê |
| **Integrations** | `pnpm test:integrations` | Tích hợp bên thứ ba (Zotero, Mendeley, GitHub tokens) |
| **Sticky Notes** | `pnpm test:sticky` | Sticky notes, memo nhanh, quick canvas |
| **Smoke Test** | `pnpm test:smoke` | **Kiểm tra 5 luồng sống còn (Golden Paths) < 15s trước khi deploy** |
| **Git Changed** | `pnpm test:changed` | **Tự động quét và chỉ chạy các test liên quan tới Git Diff hiện tại** |
| **Trợ giúp** | `pnpm test:help` | In bảng chỉ dẫn nhanh các lệnh test trực tiếp trên Terminal |

---

## 3. Dấu Hiệu Nhận Biết: Chạy Đúng vs Chạy Sai

### ✅ Dấu Hiệu Bạn Đang Chạy ĐÚNG:
1. **Lệnh chạy có scoping**: Bạn chạy `pnpm test:work-item` hoặc `pnpm test -- <tên-file>`.
2. **Terminal in ra dòng xác nhận pattern**:
   ```text
   Ran all test suites matching work-item.
   ```
3. **Thời gian chạy**: Dưới 30–60 giây (tùy số lượng file của module).
4. **Kết quả**: Tất cả test suites của module đều báo `PASS` với Exit Code `0`.

### ❌ Dấu Hiệu Bạn Đang Chạy SAI / LẠM DỤNG:
1. Gõ `pnpm test` trong khi chỉ vừa sửa code của 1 tính năng.
2. Terminal bắt đầu in hàng chục dòng warning hoặc chạy qua các module không liên quan (ví dụ: đang code `work-item` nhưng Jest lại compile cả OCR của `library` hay LaTeX của `manuscripts`).
3. Thời gian chạy kéo dài hàng phút, quạt máy kêu to và ngốn RAM/CPU.

---

## 4. Cấu Trúc Tổ Chức Thư Mục Test

```text
backend/test/
├── factories/                          # [Pattern: Object Mother] Data Builders (user, library-item, work-item)
├── mocks/                              # [Pattern: Test Doubles] In-memory Prisma & Redis mocks
├── smoke/                              # [Pattern: Smoke Testing] 5 Golden Paths chạy trong ~13s
├── unit/                               # Unit test độc lập (Isolated theo 10 module)
├── integration/                        # Test tích hợp luồng DB/Redis/OCR
├── e2e/                                # Test toàn diện qua HTTP API
├── setup-jest.ts                       # Global setup: clear mocks, noise filter, env guard, custom matchers
└── jest-matchers.d.ts                  # TypeScript types cho custom matchers
```

---

## 5. Tự Động Hóa Pre-commit (Husky + lint-staged)

Dự án đã tích hợp sẵn Git Pre-commit Hook tự động:
1. **Format Staged Code**: Tự động chạy `prettier --write` trên các file TypeScript/JSON được stage (`git add`).
2. **Chạy Scoped Test Tự Động**: Tự động gọi `pnpm test:changed` trước khi commit hoàn tất.
   - Nếu bạn sửa file nào, Git Hook chỉ chạy các test liên quan trực tiếp đến file đó trong **3–5 giây**.
   - Nếu không có test nào bị ảnh hưởng, cờ `--passWithNoTests` sẽ cho qua ngay lập tức mà không chặn commit.
   - Đảm bảo **100% không bao giờ commit nhầm code gây vỡ hệ thống**.

---

## 6. Mẹo Tăng Tốc Độ Khi Viết Test
* Để chạy test ở chế độ watch khi đang TDD:
  ```bash
  pnpm test:watch -- work-item
  ```
* Để chỉ chạy 1 file duy nhất:
  ```bash
  pnpm test test/unit/work-item/work-item-creation.spec.ts
  ```
