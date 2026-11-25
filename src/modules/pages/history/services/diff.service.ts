import { Injectable, Optional } from '@nestjs/common';
import { HistoryRepository } from '../history.repository';
import { VersionNotFoundException } from '../domain/errors';
import { DiffEngine } from '../domain/diff.engine';
import { DiffResponseDto } from '../dto/diff.dto';

const DIFF_CACHE_MAX_ENTRIES = 256;
const DIFF_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32 MB total budget
const DIFF_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024; // skip caching single diffs > 4 MB

interface CachedDiffEntry {
  value: DiffResponseDto;
  bytes: number;
}

@Injectable()
export class DiffService {
  private readonly diffEngine: DiffEngine;
  private readonly diffCache = new Map<string, CachedDiffEntry>();
  private cachedBytes = 0;

  constructor(
    private readonly repository: HistoryRepository,
    @Optional() diffEngine?: DiffEngine,
  ) {
    this.diffEngine = diffEngine ?? new DiffEngine();
  }

  public async compareVersions(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
    pageId?: string,
  ): Promise<DiffResponseDto> {
    const cacheKey = `${projectId}:${pageId ?? '*'}:${baseVersion}:${targetVersion}`;
    const cached = this.getCachedDiff(cacheKey);
    if (cached) {
      return cached;
    }

    const [baseSnapshot, targetSnapshot] = await Promise.all([
      this.repository.findByVersion(projectId, baseVersion, pageId),
      this.repository.findByVersion(projectId, targetVersion, pageId),
    ]);
    if (!baseSnapshot) {
      throw new VersionNotFoundException(projectId, baseVersion);
    }
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    const fileDiffs = this.diffEngine.compareSnapshots(
      baseSnapshot,
      targetSnapshot,
    );
    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const fd of fileDiffs) {
      totalAdditions += fd.additions;
      totalDeletions += fd.deletions;
    }

    const result: DiffResponseDto = {
      baseVersion,
      targetVersion,
      totalAdditions,
      totalDeletions,
      filesChanged: fileDiffs.length,
      files: fileDiffs,
    };

    this.setCachedDiff(cacheKey, result);
    return result;
  }

  private getCachedDiff(key: string): DiffResponseDto | undefined {
    const hit = this.diffCache.get(key);
    if (!hit) return undefined;
    // O(1) LRU promotion
    this.diffCache.delete(key);
    this.diffCache.set(key, hit);
    return hit.value;
  }

  private setCachedDiff(key: string, value: DiffResponseDto): void {
    const bytes = this.estimateBytes(value);
    if (bytes > DIFF_CACHE_MAX_ENTRY_BYTES) {
      return;
    }

    const existing = this.diffCache.get(key);
    if (existing) {
      this.cachedBytes -= existing.bytes;
      this.diffCache.delete(key);
    }

    while (
      this.diffCache.size >= DIFF_CACHE_MAX_ENTRIES ||
      (this.cachedBytes + bytes > DIFF_CACHE_MAX_BYTES && this.diffCache.size > 0)
    ) {
      const oldestKey = this.diffCache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.diffCache.get(oldestKey);
      if (oldest) this.cachedBytes -= oldest.bytes;
      this.diffCache.delete(oldestKey);
    }

    this.diffCache.set(key, { value, bytes });
    this.cachedBytes += bytes;
  }

  private estimateBytes(diff: DiffResponseDto): number {
    let bytes = 256;
    for (const f of diff.files) {
      bytes += 128 + (f.path?.length ?? 0) * 2;
      for (const h of f.hunks) {
        bytes += 64;
        for (const line of h.lines) {
          bytes += 32 + (line.text?.length ?? 0) * 2;
        }
      }
    }
    return bytes;
  }
}
