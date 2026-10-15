/**
 * modules/manuscripts/spelling/index.ts
 * Public entrypoint and barrel export for the Manuscripts Spelling subsystem.
 */

export * from './spelling.module';
export * from './spelling.service';
export * from './spelling.controller';
export * from './spelling.repository';
export * from './dto/spelling.dto';

// Pure Domain
export * from './domain';

// Ports
export * from './core/ports/latex-tokenizer.port';
export * from './core/ports/spell-engine.port';
export * from './core/ports/custom-dictionary-repository.port';

// Use Cases
export * from './core/use-cases/check-spelling.use-case';
export * from './core/use-cases/get-suggestions.use-case';
export * from './core/use-cases/learn-word.use-case';
export * from './core/use-cases/unlearn-word.use-case';
export * from './core/use-cases/list-custom-words.use-case';

// Adapters
export * from './core/adapters/tokenizer/regex-latex-tokenizer.adapter';
export * from './core/adapters/engine/academic-spell-engine.adapter';
export * from './core/adapters/storage/in-memory-custom-dictionary.adapter';
export * from './core/adapters/storage/prisma-custom-dictionary.adapter';
