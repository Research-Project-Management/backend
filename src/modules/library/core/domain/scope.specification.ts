/**
 * Scope normalization and user/project resolution helpers.
 *
 * Pure Shared Kernel primitive used across Library bounded contexts
 * (Catalog, Search, Sync, Ingestion, Extraction, Citation) to distinguish
 * collaborative project scope from personal user library scope.
 */

const PERSONAL_SCOPE_ALIASES = new Set([
  'user',
  'me',
  'personal',
  'undefined',
  'null',
]);

/**
 * Type guard that checks whether a candidate projectId represents a valid
 * collaborative project scope (as opposed to personal library aliases like
 * 'user', 'me', 'personal', or empty values).
 */
export function isProjectScopeId(
  projectId?: string | null,
): projectId is string {
  if (!projectId || typeof projectId !== 'string') {
    return false;
  }
  const trimmed = projectId.trim();
  return (
    trimmed.length > 0 && !PERSONAL_SCOPE_ALIASES.has(trimmed.toLowerCase())
  );
}

/**
 * Normalizes a candidate projectId into a valid project UUID/identifier string
 * or `undefined` if it is empty or a personal library alias ('user', 'me', 'personal').
 */
export function normalizeProjectScopeId(
  projectId?: string | null,
): string | undefined {
  return isProjectScopeId(projectId) ? projectId.trim() : undefined;
}

export interface IScopeSpecificationOperand {
  toPrismaWhere(): Record<string, unknown>;
  isSatisfiedBy?: (item: unknown) => boolean;
}

class CompositeScopeSpecification implements IScopeSpecificationOperand {
  constructor(
    private readonly left: IScopeSpecificationOperand,
    private readonly right: IScopeSpecificationOperand,
  ) {}

  toPrismaWhere(): Record<string, unknown> {
    return {
      AND: [this.left.toPrismaWhere(), this.right.toPrismaWhere()],
    };
  }

  isSatisfiedBy(item: unknown): boolean {
    const leftValid =
      typeof this.left.isSatisfiedBy === 'function'
        ? this.left.isSatisfiedBy(item)
        : true;
    const rightValid =
      typeof this.right.isSatisfiedBy === 'function'
        ? this.right.isSatisfiedBy(item)
        : true;
    return leftValid && rightValid;
  }

  and(other: IScopeSpecificationOperand): CompositeScopeSpecification {
    return new CompositeScopeSpecification(this, other);
  }
}

/**
 * ScopeSpecification: Enforces user & project scope isolation.
 * Resolves to projectId for user projects, or userId for personal user library.
 */
export class ScopeSpecification implements IScopeSpecificationOperand {
  constructor(
    public readonly userId: string,
    public readonly projectId?: string | null,
  ) {}

  toPrismaWhere(): Record<string, unknown> {
    if (isProjectScopeId(this.projectId)) {
      return { projectId: this.projectId.trim() };
    }
    return { userId: this.userId, projectId: null };
  }

  isSatisfiedBy(item: unknown): boolean {
    if (!item || typeof item !== 'object') return false;
    const rec = item as Record<string, unknown>;
    if (isProjectScopeId(this.projectId)) {
      return rec.projectId === this.projectId.trim();
    }
    return rec.userId === this.userId && (!rec.projectId || rec.projectId === null);
  }

  and(other: IScopeSpecificationOperand): CompositeScopeSpecification {
    return new CompositeScopeSpecification(this, other);
  }
}
