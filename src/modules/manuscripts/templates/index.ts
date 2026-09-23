export * from './templates.module';
export * from './templates.service';
export * from './templates.controller';
export * from './dto/template.dto';

// Domain
export * from './core/domain/entities/manuscript-template.entity';
export * from './core/domain/value-objects/template-category.vo';
export * from './core/domain/value-objects/compiler-type.vo';
export * from './core/domain/exceptions/template-not-found.exception';
export * from './core/domain/exceptions/invalid-template.exception';

// Ports
export * from './core/ports/template-repository.port';
export * from './core/ports/project-instantiator.port';

// Adapters
export * from './core/adapters/storage/in-memory-template.adapter';
export * from './core/adapters/storage/prisma-template.adapter';
export * from './core/adapters/external/manuscript-instantiator.adapter';

// Use Cases
export * from './core/use-cases/list-templates.use-case';
export * from './core/use-cases/get-template-by-id.use-case';
export * from './core/use-cases/search-templates.use-case';
export * from './core/use-cases/instantiate-template.use-case';
export * from './core/use-cases/create-custom-template.use-case';
