export * from './templates.module';
export * from './templates.service';
export * from './templates.repository';
export * from './templates.controller';
export * from './dto/template.dto';
export * from './domain';

// Backward-compatible re-exports on core/*
export * from './core/ports/template-repository.port';
export * from './core/ports/project-instantiator.port';
export * from './core/adapters/storage/in-memory-template.adapter';
export * from './core/adapters/storage/prisma-template.adapter';
export * from './core/adapters/external/manuscript-instantiator.adapter';
export * from './core/use-cases/list-templates.use-case';
export * from './core/use-cases/get-template-by-id.use-case';
export * from './core/use-cases/search-templates.use-case';
export * from './core/use-cases/instantiate-template.use-case';
export * from './core/use-cases/create-custom-template.use-case';
