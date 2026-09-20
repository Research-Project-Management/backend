/**
 * Base Domain Exception for Catalog Domain.
 */
export abstract class CatalogDomainException extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ItemValidationDomainException extends CatalogDomainException {
  constructor(message: string) {
    super(message);
  }
}

export class ItemConcurrencyDomainException extends CatalogDomainException {
  constructor(
    public readonly itemId: string,
    public readonly currentVersion: number,
    public readonly expectedVersion?: number,
  ) {
    super(
      `Concurrency conflict on item ${itemId}: current version is ${currentVersion}, expected was ${expectedVersion ?? 'unspecified'}.`,
    );
  }
}

export class ItemNotFoundDomainException extends CatalogDomainException {
  constructor(public readonly itemId: string) {
    super(`Catalog item not found: "${itemId}".`);
  }
}
