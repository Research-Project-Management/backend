/**
 * notifications/core/ports/review-bundle-store.port.ts
 * Outbound port persisting per-user bundling settings and digest history.
 */

import {
  ReviewBundlingSettings,
  ReviewDigest,
} from '../domain/value-objects/review-bundle';

export abstract class ReviewBundleStorePort {
  abstract getSettings(userId: string): Promise<ReviewBundlingSettings>;
  abstract saveSettings(
    userId: string,
    settings: ReviewBundlingSettings,
  ): Promise<ReviewBundlingSettings>;
  abstract appendDigest(userId: string, digest: ReviewDigest): Promise<void>;
  abstract listDigests(userId: string, limit: number): Promise<ReviewDigest[]>;
}
