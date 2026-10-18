export type QueryCriteria = Record<string, unknown>;

/**
 * Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - In-memory evaluation via `isSatisfiedBy(candidate)` (great for unit tests and local filters)
 * - Database query compilation via `toPrismaWhere()` / `toQueryCriteria()`
 * - Logical composition via `.and()`, `.or()`, and `.not()`
 */
export interface ISpecification<T = unknown> {
  isSatisfiedBy(candidate: T): boolean;
  toPrismaWhere(): QueryCriteria;
  and(other: ISpecification<T>): ISpecification<T>;
  or(other: ISpecification<T>): ISpecification<T>;
  not(): ISpecification<T>;
}

export abstract class CompositeSpecification<
  T = unknown,
> implements ISpecification<T> {
  abstract isSatisfiedBy(candidate: T): boolean;
  abstract toPrismaWhere(): QueryCriteria;

  and(other: ISpecification<T>): ISpecification<T> {
    return new DerivedSpecification<T>(
      (c) => this.isSatisfiedBy(c) && other.isSatisfiedBy(c),
      () => ({ AND: [this.toPrismaWhere(), other.toPrismaWhere()] }),
    );
  }

  or(other: ISpecification<T>): ISpecification<T> {
    return new DerivedSpecification<T>(
      (c) => this.isSatisfiedBy(c) || other.isSatisfiedBy(c),
      () => ({ OR: [this.toPrismaWhere(), other.toPrismaWhere()] }),
    );
  }

  not(): ISpecification<T> {
    return new DerivedSpecification<T>(
      (c) => !this.isSatisfiedBy(c),
      () => ({ NOT: this.toPrismaWhere() }),
    );
  }
}

/** Specification built from closures; declared after its base class. */
class DerivedSpecification<T> extends CompositeSpecification<T> {
  constructor(
    private readonly satisfied: (candidate: T) => boolean,
    private readonly where: () => QueryCriteria,
  ) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return this.satisfied(candidate);
  }

  toPrismaWhere(): QueryCriteria {
    return this.where();
  }
}
