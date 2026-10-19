export type QueryCriteria = Record<string, unknown>;

/**
 * Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - Database query compilation via `toPrismaWhere()`
 * - Logical composition via `.and()`
 */
export interface ISpecification {
  toPrismaWhere(): QueryCriteria;
  and(other: ISpecification): ISpecification;
}

export abstract class CompositeSpecification implements ISpecification {
  abstract toPrismaWhere(): QueryCriteria;

  and(other: ISpecification): ISpecification {
    return new DerivedSpecification(() => ({
      AND: [this.toPrismaWhere(), other.toPrismaWhere()],
    }));
  }
}

/** Specification built from closures; declared after its base class. */
class DerivedSpecification extends CompositeSpecification {
  constructor(private readonly where: () => QueryCriteria) {
    super();
  }

  toPrismaWhere(): QueryCriteria {
    return this.where();
  }
}

