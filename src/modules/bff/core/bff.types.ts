/**
 * modules/bff/core/bff.types.ts
 * Shared contracts for all channel-specific BFF modules (web, mobile, etc.).
 */

export type BffClientChannel = 'web' | 'mobile';

export interface BffResponseMeta {
  channel: BffClientChannel;
  partial: boolean;
  degradedSections: string[];
  timedOutSections: string[];
  cacheHit: boolean;
  generatedAt: string;
  durationMs: number;
}

export interface BffEnvelope<TData> {
  data: TData;
  meta: BffResponseMeta;
}

export interface BffSectionOutcome<T> {
  section: string;
  value: T;
  degraded: boolean;
  timedOut: boolean;
}
