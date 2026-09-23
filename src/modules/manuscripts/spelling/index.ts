/**
 * spelling/index.ts
 * Public entrypoint and barrel export for the Manuscripts Spelling subsystem.
 */

export * from './spelling.module';
export * from './spelling.service';
export * from './spelling.controller';
export * from './dto/spelling.dto';

// Ports
export * from './core/ports/latex-tokenizer.port';
export * from './core/ports/spell-engine.port';
export * from './core/ports/custom-dictionary-repository.port';

// Domain
export * from './core/domain/entities/misspelled-word.entity';
export * from './core/domain/entities/spelling-report.entity';
export * from './core/domain/value-objects/language-code.vo';
export * from './core/domain/value-objects/word-token.vo';
export * from './core/domain/value-objects/dictionary-scope.vo';
export * from './core/domain/exceptions/unsupported-language.exception';
export * from './core/domain/exceptions/invalid-word.exception';

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
