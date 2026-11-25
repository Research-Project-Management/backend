/**
 * modules/pages/clsi/domain/log-parser/diagnostic.normalizer.ts
 * Pure domain post-processing pipeline for parsed compiler diagnostics:
 * 1) Deduplication
 * 2) Cascade Error Suppression (Emergency stop / Fatal error after root cause)
 * 3) Transient Warning Filtering under stopOnFirstError
 * 4) Deterministic Hard Cap with accurate DiagnosticsSummary
 */

import type {
  CompilerDiagnostic,
  DiagnosticsSummary,
} from '../ports';
import {
  CASCADE_SUPPRESSION_MAP,
  FATAL_CASCADE_PATTERNS,
} from './error.catalog';

const DEFAULT_MAX_DIAGNOSTICS = 200;
const TRANSIENT_REF_CITE_REGEX =
  /(?:Reference|Citation)\s+.+undefined\s+on\s+input\s+line/i;

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/^(?:!|latex error:|error:|\s)+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
}

export function postProcessDiagnostics(
  rawDiagnostics: CompilerDiagnostic[],
  options: {
    stopOnFirstError?: boolean;
    maxDiagnostics?: number;
  } = {},
): {
  diagnostics: CompilerDiagnostic[];
  summary: DiagnosticsSummary;
} {
  const maxDiagnostics = Math.max(
    1,
    options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS,
  );

  // 1. Deduplication preserving first occurrence order
  const seenKeys = new Set<string>();
  const deduped: CompilerDiagnostic[] = [];
  for (const item of rawDiagnostics) {
    const fileKey = (item.file || '').replace(/\\/g, '/').toLowerCase();
    const key = `${fileKey}::${item.line ?? ''}::${item.severity}::${normalizeMessage(item.message)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    deduped.push(item);
  }

  // 2. Cascade suppression (Overleaf cascadesFrom parity)
  const suppressedCodes = new Set<string>();
  let hasRootError = false;
  let suppressedCascadeCount = 0;
  const afterCascade: CompilerDiagnostic[] = [];

  for (const item of deduped) {
    if (item.severity === 'error') {
      const code = item.code?.toUpperCase();
      const isFatalCascadeText = FATAL_CASCADE_PATTERNS.some((pattern) =>
        pattern.test(`${item.message} ${item.context || ''}`),
      );

      if (
        hasRootError &&
        ((code && suppressedCodes.has(code)) || isFatalCascadeText)
      ) {
        suppressedCascadeCount++;
        continue;
      }

      if (code !== 'EMERGENCY_STOP' && !isFatalCascadeText) {
        hasRootError = true;
      }
      if (code && CASCADE_SUPPRESSION_MAP[code]) {
        for (const downstream of CASCADE_SUPPRESSION_MAP[code]) {
          suppressedCodes.add(downstream);
        }
      }
    }
    afterCascade.push(item);
  }

  // 3. Transient warning filter when compilation stopped on first error
  const remainingErrors = afterCascade.filter(
    (item) => item.severity === 'error',
  );
  const shouldFilterTransient =
    Boolean(options.stopOnFirstError) && remainingErrors.length > 0;

  const afterTransient = shouldFilterTransient
    ? afterCascade.filter((item) => {
        if (item.severity !== 'warning') return true;
        return !TRANSIENT_REF_CITE_REGEX.test(
          `${item.message} ${item.context || ''}`,
        );
      })
    : afterCascade;

  // Compute exact pre-cap totals
  const errorItems: CompilerDiagnostic[] = [];
  const warningItems: CompilerDiagnostic[] = [];
  const otherItems: CompilerDiagnostic[] = [];

  for (const item of afterTransient) {
    if (item.severity === 'error') {
      errorItems.push(item);
    } else if (item.severity === 'warning') {
      warningItems.push(item);
    } else {
      otherItems.push(item);
    }
  }

  const totalErrors = errorItems.length;
  const totalWarnings = warningItems.length;
  const totalBadboxes = otherItems.filter(
    (item) => item.severity === 'badbox' || item.category === 'badbox',
  ).length;

  // 4. Hard cap prioritizing errors first (up to min(100, maxDiagnostics)),
  //    then warnings, then badboxes/info
  const maxErrorSlots = Math.min(
    errorItems.length,
    Math.max(100, Math.floor(maxDiagnostics / 2)),
  );
  const selectedErrors = errorItems.slice(
    0,
    Math.min(maxErrorSlots, maxDiagnostics),
  );
  const warningSlots = Math.max(0, maxDiagnostics - selectedErrors.length);
  const selectedWarnings = warningItems.slice(0, warningSlots);
  const otherSlots = Math.max(0, warningSlots - selectedWarnings.length);
  const selectedOthers = otherItems.slice(0, otherSlots);

  const capped = [...selectedErrors, ...selectedWarnings, ...selectedOthers];
  const truncated = capped.length < afterTransient.length;

  return {
    diagnostics: capped,
    summary: {
      totalErrors,
      totalWarnings,
      totalBadboxes,
      suppressedCascadeCount,
      truncated,
    },
  };
}
