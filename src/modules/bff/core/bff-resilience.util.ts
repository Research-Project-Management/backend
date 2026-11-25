/**
 * modules/bff/core/bff-resilience.util.ts
 * Subsystem 2 & 5 (Orchestration & Resilience):
 * Per-section deadline enforcement and graceful degradation helpers.
 */

import { Logger } from '@nestjs/common';
import type { BffSectionOutcome } from './bff.types';

export const DEFAULT_BFF_SECTION_TIMEOUT_MS = 2_500;

export class BffSectionTimeoutError extends Error {
  constructor(
    public readonly section: string,
    public readonly timeoutMs: number,
  ) {
    super(`BFF section "${section}" exceeded ${timeoutMs}ms timeout`);
    this.name = 'BffSectionTimeoutError';
  }
}

/**
 * Races a loader promise against a strict deadline and always clears the timer
 * to prevent open handles in Node.js / Jest.
 */
export async function runWithTimeout<T>(
  section: string,
  loader: () => Promise<T>,
  timeoutMs = DEFAULT_BFF_SECTION_TIMEOUT_MS,
): Promise<T> {
  if (timeoutMs <= 0) {
    return loader();
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new BffSectionTimeoutError(section, timeoutMs));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  try {
    return await Promise.race([loader(), timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Executes a non-critical BFF section with timeout protection.
 * On error or timeout, logs a warning and returns the fallback so the screen
 * degrades partially instead of failing with HTTP 500.
 */
export async function settleOptionalSection<T>(
  section: string,
  loader: () => Promise<T>,
  fallback: T,
  options?: {
    timeoutMs?: number;
    logger?: Logger;
  },
): Promise<BffSectionOutcome<T>> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_BFF_SECTION_TIMEOUT_MS;

  try {
    const value = await runWithTimeout(section, loader, timeoutMs);
    return {
      section,
      value,
      degraded: false,
      timedOut: false,
    };
  } catch (err: unknown) {
    const timedOut = err instanceof BffSectionTimeoutError;
    const msg = err instanceof Error ? err.message : String(err);
    options?.logger?.warn(
      `BFF optional section "${section}" ${timedOut ? 'timed out' : 'degraded'}: ${msg}`,
    );
    return {
      section,
      value: fallback,
      degraded: true,
      timedOut,
    };
  }
}

export function summarizeSectionOutcomes(
  outcomes: ReadonlyArray<
    Pick<BffSectionOutcome<unknown>, 'section' | 'degraded' | 'timedOut'>
  >,
): {
  degradedSections: string[];
  timedOutSections: string[];
  partial: boolean;
} {
  const degradedSections: string[] = [];
  const timedOutSections: string[] = [];

  for (const outcome of outcomes) {
    if (outcome.degraded) {
      degradedSections.push(outcome.section);
    }
    if (outcome.timedOut) {
      timedOutSections.push(outcome.section);
    }
  }

  return {
    degradedSections,
    timedOutSections,
    partial: degradedSections.length > 0,
  };
}
