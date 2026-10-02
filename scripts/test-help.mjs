#!/usr/bin/env node

console.log(`
\x1b[1m\x1b[36m======================================================================
  FLUX BACKEND — MODULAR TEST WORKFLOW GUIDE
======================================================================\x1b[0m

  \x1b[33m[!] LƯU Ý CHO DEVELOPERS:\x1b[0m
  Để tránh lãng phí thời gian và làm nghẽn máy (Jest scan toàn bộ 96+ tests),
  hãy CHỈ chạy test theo module mà bạn đang trực tiếp phát triển hoặc sửa đổi:

  \x1b[1m📦 LỆNH CHẠY THEO MODULE:\x1b[0m
    • \x1b[32mpnpm test:work-item\x1b[0m   -> Module Work-Item (Tasks, Relations, Attachments)
    • \x1b[32mpnpm test:library\x1b[0m     -> Module Library (Zotero Parity, Citations, OCR, Ingestion)
    • \x1b[32mpnpm test:manuscripts\x1b[0m -> Module Manuscripts (Overleaf Parity, LaTeX, Docstore)
    • \x1b[32mpnpm test:storage\x1b[0m     -> Module Storage (S3, Multipart, Presigned, Lifecycle)
    • \x1b[32mpnpm test:identity\x1b[0m    -> Module Identity & Security (Auth, Users, Tokens)
    • \x1b[32mpnpm test:ai\x1b[0m          -> Module AI & Semantic Search (Threads, RAG)
    • \x1b[32mpnpm test:project\x1b[0m     -> Module Project Management (Access, State, Modules)
    • \x1b[32mpnpm test:analytics\x1b[0m   -> Module Analytics & Your-Work Dashboard
    • \x1b[32mpnpm test:integrations\x1b[0m-> Module External Integrations (Zotero, Mendeley, GitHub)
    • \x1b[32mpnpm test:sticky\x1b[0m      -> Module Sticky Notes & Quick Canvas

  \x1b[1m⚡ THÔNG MINH (RECOMMENDED CHO LOCAL DEV & TRƯỚC KHI DEPLOY):\x1b[0m
    • \x1b[33mpnpm test:smoke\x1b[0m       -> Golden-Path Smoke Test (5 luồng sống còn <15s trước khi deploy)
    • \x1b[32mpnpm test:changed\x1b[0m     -> Tự động CHỈ chạy các test bị ảnh hưởng bởi Git diff!
    • \x1b[32mpnpm test -- <file>\x1b[0m   -> Chỉ chạy duy nhất 1 file test cụ thể

  \x1b[1m🌐 DÀNH RIÊNG CHO CI/CD:\x1b[0m
    • \x1b[31mpnpm test\x1b[0m             -> Chạy toàn bộ hệ thống (chỉ nên dùng trước khi merge PR)

  \x1b[35mChi tiết cấu trúc & quy chuẩn: xem file backend/TESTING.md\x1b[0m
\x1b[1m\x1b[36m======================================================================\x1b[0m
`);
