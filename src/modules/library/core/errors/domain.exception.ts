/**
 * Universal Base Domain Exception for all Bounded Contexts in the Library module.
 *
 * Clean Architecture & DDD Core Policy:
 * Shared Kernel provides the base exception abstraction so that infrastructure filters
 * can handle domain errors without importing child context domain exceptions.
 */
export abstract class BaseDomainException extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
