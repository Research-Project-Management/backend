import { Prisma } from '@prisma/client';

/**
 * Specification Pattern Interface.
 *
 * Encapsulates domain query and filtering criteria into reusable, composable objects.
 * Supports:
 * - In-memory evaluation via `isSatisfiedBy(candidate)` (great for unit tests and local filters)
 * - Database query compilation via `toPrismaWhere()`
 * - Logical composition via `.and()`, `.or()`, and `.not()`
 */
export interface ISpecification<T = any> {
  isSatisfiedBy(candidate: T): boolean;
  toPrismaWhere(): Prisma.ItemWhereInput;
  and(other: ISpecification<T>): ISpecification<T>;
  or(other: ISpecification<T>): ISpecification<T>;
  not(): ISpecification<T>;
}

export abstract class CompositeSpecification<T = any>
  implements ISpecification<T>
{
  abstract isSatisfiedBy(candidate: T): boolean;
  abstract toPrismaWhere(): Prisma.ItemWhereInput;

  and(other: ISpecification<T>): ISpecification<T> {
    return new AndSpecification(this, other);
  }

  or(other: ISpecification<T>): ISpecification<T> {
    return new OrSpecification(this, other);
  }

  not(): ISpecification<T> {
    return new NotSpecification(this);
  }
}

export class AndSpecification<T = any> extends CompositeSpecification<T> {
  constructor(
    private readonly left: ISpecification<T>,
    private readonly right: ISpecification<T>,
  ) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return (
      this.left.isSatisfiedBy(candidate) && this.right.isSatisfiedBy(candidate)
    );
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    return {
      AND: [leftWhere, rightWhere],
    };
  }
}

export class OrSpecification<T = any> extends CompositeSpecification<T> {
  constructor(
    private readonly left: ISpecification<T>,
    private readonly right: ISpecification<T>,
  ) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return (
      this.left.isSatisfiedBy(candidate) || this.right.isSatisfiedBy(candidate)
    );
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    const leftWhere = this.left.toPrismaWhere();
    const rightWhere = this.right.toPrismaWhere();
    return {
      OR: [leftWhere, rightWhere],
    };
  }
}

export class NotSpecification<T = any> extends CompositeSpecification<T> {
  constructor(private readonly spec: ISpecification<T>) {
    super();
  }

  isSatisfiedBy(candidate: T): boolean {
    return !this.spec.isSatisfiedBy(candidate);
  }

  toPrismaWhere(): Prisma.ItemWhereInput {
    return {
      NOT: this.spec.toPrismaWhere(),
    };
  }
}
