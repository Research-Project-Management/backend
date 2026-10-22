export type QueryCriteria = Record<string, unknown>;

/**
 * Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - In-memory predicate evaluation via `isSatisfiedBy(item)`
 * - Database query compilation via `toPrismaWhere()`
 * - Logical composition via `.and()`
 */
export interface ISpecification {
  toPrismaWhere(): QueryCriteria;
  isSatisfiedBy(item: unknown): boolean;
  and(other: ISpecification): ISpecification;
}

export abstract class CompositeSpecification implements ISpecification {
  abstract toPrismaWhere(): QueryCriteria;
  abstract isSatisfiedBy(item: unknown): boolean;

  and(other: ISpecification): ISpecification {
    return new AndSpecification(this, other);
  }
}

export class AndSpecification extends CompositeSpecification {
  constructor(
    private readonly left: ISpecification,
    private readonly right: ISpecification,
  ) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return {
      AND: [this.left.toPrismaWhere(), this.right.toPrismaWhere()],
    };
  }

  isSatisfiedBy(item: unknown): boolean {
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
