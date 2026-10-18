/**
 * modules/manuscripts/spelling/index.ts
 * Public entrypoint and barrel export for the Manuscripts Spelling subsystem.
 */

export * from './spelling.module';
export * from './spelling.service';
export * from './spelling.controller';
export * from './spelling.repository';
export * from './dto/spelling.dto';

// Pure Domain & Ports
export * from './domain';
