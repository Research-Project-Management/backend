export type QueryCriteria = Record<string, unknown>;

/**
 * GoF / DDD Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - In-memory predicate evaluation via `isSatisfiedBy(item)`
 * - Database query compilation via `toPrismaWhere()`
 * - Logical composition via `.and()`, `.or()`, and `.not()`
 */
export interface ISpecification<T = unknown, TWhere = QueryCriteria> {
  toPrismaWhere(): TWhere;
  isSatisfiedBy(item: T): boolean;
  and(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  or(other: ISpecification<T, TWhere>): ISpecification<T, TWhere>;
  not(): ISpecification<T, TWhere>;
}

export abstract class CompositeSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> implements ISpecification<T, TWhere> {
  abstract toPrismaWhere(): TWhere;
  abstract isSatisfiedBy(item: T): boolean;

  and(other: ISpecification<T, TWhere>): ISpecification<T, TWhere> {
    return new AndSpecification<T, TWhere>(this, other);
  }

  or(other: ISpecification<T, TWhere>): ISpecification<T, TWhere> {
    return new OrSpecification<T, TWhere>(this, other);
  }

  not(): ISpecification<T, TWhere> {
    return new NotSpecification<T, TWhere>(this);
  }
}

function isEmptyWhereObject(where: unknown): boolean {
  return (
    !where ||
    (typeof where === 'object' &&
      !Array.isArray(where) &&
      Object.keys(where).length === 0)
  );
}

function extractCombinatorClauses(
  where: unknown,
  operator: 'AND' | 'OR',
): unknown[] {
  if (where && typeof where === 'object' && !Array.isArray(where)) {
    const rec = where as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (
      keys.length === 1 &&
      keys[0] === operator &&
      Array.isArray(rec[operator])
    ) {
      return rec[operator] as unknown[];
    }
  }
  return [where];
}

export class AndSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(
    private readonly left: ISpecification<T, TWhere>,
    private readonly right: ISpecification<T, TWhere>,
  ) {
    super();
  }

  toPrismaWhere(): TWhere {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    const leftEmpty = isEmptyWhereObject(leftWhere);
    const rightEmpty = isEmptyWhereObject(rightWhere);

    if (leftEmpty && rightEmpty) {
      return {} as unknown as TWhere;
    }
    if (leftEmpty) {
      return rightWhere;
    }
    if (rightEmpty) {
      return leftWhere;
    }

    return {
      AND: [
        ...extractCombinatorClauses(leftWhere, 'AND'),
        ...extractCombinatorClauses(rightWhere, 'AND'),
      ],
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return (
      (typeof this.left.isSatisfiedBy === 'function'
        ? this.left.isSatisfiedBy(item)
        : true) &&
      (typeof this.right.isSatisfiedBy === 'function'
        ? this.right.isSatisfiedBy(item)
        : true)
    );
  }
}

export class OrSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(
    private readonly left: ISpecification<T, TWhere>,
    private readonly right: ISpecification<T, TWhere>,
  ) {
    super();
  }

  toPrismaWhere(): TWhere {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    const leftEmpty = isEmptyWhereObject(leftWhere);
    const rightEmpty = isEmptyWhereObject(rightWhere);

    if (leftEmpty && rightEmpty) {
      return {} as unknown as TWhere;
    }
    if (leftEmpty) {
      return rightWhere;
    }
    if (rightEmpty) {
      return leftWhere;
    }

    return {
      OR: [
        ...extractCombinatorClauses(leftWhere, 'OR'),
        ...extractCombinatorClauses(rightWhere, 'OR'),
      ],
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return (
      (typeof this.left.isSatisfiedBy === 'function'
        ? this.left.isSatisfiedBy(item)
        : false) ||
      (typeof this.right.isSatisfiedBy === 'function'
        ? this.right.isSatisfiedBy(item)
        : false)
    );
  }
}

export class NotSpecification<
  T = unknown,
  TWhere = QueryCriteria,
> extends CompositeSpecification<T, TWhere> {
  constructor(private readonly wrapped: ISpecification<T, TWhere>) {
    super();
  }

  toPrismaWhere(): TWhere {
    return {
      NOT: this.wrapped.toPrismaWhere(),
    } as unknown as TWhere;
  }

  isSatisfiedBy(item: T): boolean {
    return typeof this.wrapped.isSatisfiedBy === 'function'
      ? !this.wrapped.isSatisfiedBy(item)
      : false;
  }
}
