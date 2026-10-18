// ─── Enums & Definitions ───────────────────────────────────────────────────
export * from './enums/role.enum';
export * from './enums/permission.enum';

// ─── Constants & Evaluation Engine ──────────────────────────────────────────
export * from './constants/permission.constant';
export * from './constants/redis.constant';

// ─── Types & Contracts ──────────────────────────────────────────────────────
export * from './types/access.type';

// ─── Decorators ─────────────────────────────────────────────────────────────
export * from './decorators/require-role.decorator';
export * from './decorators/require-permission.decorator';
export * from './decorators/current-member.decorator';
export * from './decorators/resolved-project.decorator';
export * from './decorators/no-project-context.decorator';
export * from './decorators/require-operator.decorator';
export * from './config/access.config';

// ─── Guards ─────────────────────────────────────────────────────────────────
export * from './guards/project-access.guard';
export * from './guards/operator.guard';

// ─── Services & Repositories ────────────────────────────────────────────────
export * from './access.repository';
export * from './access.service';

// ─── DTOs ───────────────────────────────────────────────────────────────────
export * from './dto/check-access.dto';
export * from './dto/access-response.dto';

// ─── Controller & Module ────────────────────────────────────────────────────
export * from './access.controller';
export * from './access.module';
