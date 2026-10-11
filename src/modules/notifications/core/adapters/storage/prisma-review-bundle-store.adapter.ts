/**
 * notifications/core/adapters/storage/prisma-review-bundle-store.adapter.ts
 *
 * Persists bundling settings + digest history inside
 * UserSettings.editorConfig.reviewNotifications (JSON; no schema migration).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { ReviewBundleStorePort } from '../../ports/review-bundle-store.port';
import {
  normalizeSettings,
  ReviewBundlingSettings,
  ReviewDigest,
} from '../../domain/value-objects/review-bundle';

const MAX_DIGESTS = 50;

interface StoredState {
  settings?: Partial<ReviewBundlingSettings>;
  digests?: ReviewDigest[];
}

@Injectable()
export class PrismaReviewBundleStoreAdapter extends ReviewBundleStorePort {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private async read(userId: string): Promise<{
    editorConfig: Record<string, any>;
    state: StoredState;
  }> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { editorConfig: true },
    });
    const editorConfig = (row?.editorConfig as Record<string, any>) || {};
    return {
      editorConfig,
      state: (editorConfig.reviewNotifications as StoredState) || {},
    };
  }

  private async write(
    userId: string,
    editorConfig: Record<string, any>,
    state: StoredState,
  ): Promise<void> {
    const next = {
      ...editorConfig,
      reviewNotifications: state,
    } as unknown as Prisma.InputJsonValue;
    await this.prisma.userSettings.upsert({
      where: { userId },
      create: { userId, editorConfig: next },
      update: { editorConfig: next },
    });
  }

  async getSettings(userId: string): Promise<ReviewBundlingSettings> {
    const { state } = await this.read(userId);
    return normalizeSettings(state.settings);
  }

  async saveSettings(
    userId: string,
    settings: ReviewBundlingSettings,
  ): Promise<ReviewBundlingSettings> {
    const { editorConfig, state } = await this.read(userId);
    const normalized = normalizeSettings(settings);
    await this.write(userId, editorConfig, { ...state, settings: normalized });
    return normalized;
  }

  async appendDigest(userId: string, digest: ReviewDigest): Promise<void> {
    const { editorConfig, state } = await this.read(userId);
    const digests = [digest, ...(state.digests || [])].slice(0, MAX_DIGESTS);
    await this.write(userId, editorConfig, { ...state, digests });
  }

  async listDigests(userId: string, limit: number): Promise<ReviewDigest[]> {
    const { state } = await this.read(userId);
    return (state.digests || []).slice(0, Math.max(1, Math.min(limit, MAX_DIGESTS)));
  }
}
