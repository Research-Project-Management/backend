/**
 * project-history/core/use-cases/compare-versions-diff.use-case.ts
 * Inbound Use Case generating Myers line-diffs and word highlights between two snapshot versions.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';
import { IDiffEnginePort } from '../ports/diff-engine.port';
import { FileDiffVo } from '../domain/value-objects/file-diff.vo';
import { VersionNotFoundException } from '../domain/exceptions/version-not-found.exception';

export interface DiffComparisonResult {
  baseVersion: number;
  targetVersion: number;
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: number;
  files: FileDiffVo[];
}

@Injectable()
export class CompareVersionsDiffUseCase {
  constructor(
    private readonly historyRepository: IHistoryRepositoryPort,
    private readonly diffEngine: IDiffEnginePort,
  ) {}

  public async execute(
    projectId: string,
    baseVersion: number,
    targetVersion: number,
  ): Promise<DiffComparisonResult> {
    const baseSnapshot = await this.historyRepository.findByVersion(projectId, baseVersion);
    if (!baseSnapshot) {
      throw new VersionNotFoundException(projectId, baseVersion);
    }

    const targetSnapshot = await this.historyRepository.findByVersion(projectId, targetVersion);
    if (!targetSnapshot) {
      throw new VersionNotFoundException(projectId, targetVersion);
    }

    const fileDiffs = this.diffEngine.compareSnapshots(baseSnapshot, targetSnapshot);

    let totalAdditions = 0;
    let totalDeletions = 0;
    for (const fd of fileDiffs) {
      totalAdditions += fd.additions;
      totalDeletions += fd.deletions;
    }

    return {
      baseVersion,
      targetVersion,
      totalAdditions,
      totalDeletions,
      filesChanged: fileDiffs.length,
      files: fileDiffs,
    };
  }
}
