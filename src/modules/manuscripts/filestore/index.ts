/**
 * filestore/index.ts
 * Public entrypoint for Manuscripts Filestore subsystem.
 */

export * from './filestore.module';
export * from './filestore.service';
export * from './filestore.repository';
export * from './filestore.controller';
export * from './domain';
export * from './dto/file-response.dto';

// Backward-compatible re-exports on core/*
export * from './core/ports/binary-storage.port';
export * from './core/ports/manuscript-file-repository.port';
export * from './core/ports/content-hasher.port';
export * from './core/use-cases/upload-manuscript-file.use-case';
export * from './core/use-cases/stream-manuscript-file.use-case';
export * from './core/use-cases/get-manuscript-file-head.use-case';
export * from './core/use-cases/delete-manuscript-file.use-case';
export * from './core/use-cases/get-signed-download-url.use-case';
