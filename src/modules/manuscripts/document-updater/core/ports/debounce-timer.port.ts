/**
 * document-updater/core/ports/debounce-timer.port.ts
 * Outbound Port (SPI) for debounced idle flush timers.
 */

export abstract class IDebounceTimerPort {
  /**
   * Schedules a debounced callback. If already scheduled for the same doc, resets the timer.
   */
  abstract schedule(
    projectId: string,
    docId: string,
    delayMs: number,
    callback: () => Promise<void>,
  ): void;

  /**
   * Cancels a pending debounced timer for a specific document.
   */
  abstract cancel(projectId: string, docId: string): void;

  /**
   * Cancels all pending timers for a project.
   */
  abstract cancelAllForProject(projectId: string): void;

  /**
   * Cancels all active timers across all projects.
   */
  abstract cancelAll(): void;
}
