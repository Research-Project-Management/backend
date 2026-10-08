import { BaseDomainException } from '../../../shared-kernel/core/errors/domain.exception';

/**
 * Base Domain Exception for Catalog Domain.
 */
export abstract class CatalogDomainException extends BaseDomainException {
  constructor(message: string) {
    super(message);
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
