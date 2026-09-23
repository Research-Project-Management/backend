/**
 * document-updater/core/ports/updater-lock.port.ts
 * Outbound Port (SPI) for acquiring and releasing project/doc execution locks.
 * Prevents concurrent compile/flush collisions.
 */

export abstract class IUpdaterLockPort {
  /**
   * Attempts to acquire an exclusive lock on a resource (e.g. project or doc).
   * Returns true if lock was successfully acquired, false otherwise.
   */
  abstract acquire(resourceKey: string, ttlMs?: number): Promise<boolean>;

  /**
   * Releases an acquired exclusive lock.
   */
  abstract release(resourceKey: string): Promise<void>;

  /**
   * Checks whether a resource is currently locked.
   */
  abstract isLocked(resourceKey: string): Promise<boolean>;
}
