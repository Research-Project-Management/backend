/**
 * git-bridge/index.ts
 * Public entrypoint for Manuscripts Git Bridge subsystem.
 */

export * from './git-bridge.module';
export * from './git-bridge.service';
export * from './git-bridge.repository';
export * from './git-bridge.controller';
export * from './dto/git-bridge.dto';
export * from './domain';

// Backward-compatible re-exports on core/*
export * from './core/ports/git-access-repository.port';
export * from './core/ports/git-cli.port';
export * from './core/adapters/git-cli.adapter';
export * from './core/adapters/persistence/prisma-git-access.repository';
export * from './core/use-cases/git-access.use-case';
export * from './core/use-cases/git-sync.use-case';
