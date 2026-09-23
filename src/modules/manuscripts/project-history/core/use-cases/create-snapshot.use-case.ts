/**
 * project-history/core/use-cases/create-snapshot.use-case.ts
 * Inbound Use Case orchestrating the creation of a new immutable version snapshot.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';
import { IProjectCollectorPort } from '../ports/project-collector.port';
import { Snapshot } from '../domain/entities/snapshot.entity';
import { VersionLabel } from '../domain/entities/version-label.entity';
import { DuplicateLabelException } from '../domain/exceptions/duplicate-label.exception';

export interface CreateSnapshotInput {
  projectId: string;
  summary?: string | null;
  createdById?: string | null;
  isAutomatic?: boolean;
  label?: string | null;
}

@Injectable()
export class CreateSnapshotUseCase {
  constructor(
    private readonly historyRepository: IHistoryRepositoryPort,
    private readonly projectCollector: IProjectCollectorPort,
  ) {}

  public async execute(input: CreateSnapshotInput): Promise<Snapshot> {
    const { projectId, summary, createdById, isAutomatic = false, label } = input;

    // Check duplicate label early if provided
    if (label && label.trim()) {
      const existingLabel = await this.historyRepository.findLabelByName(projectId, label.trim());
      if (existingLabel) {
        throw new DuplicateLabelException(projectId, label.trim());
      }
    }

    // 1. Determine next version number
    const latestVersion = await this.historyRepository.getLatestVersion(projectId);
    const nextVersion = latestVersion + 1;

    // 2. Collect current project files state
    const files = await this.projectCollector.collectCurrentState(projectId);

    // 3. Build snapshot entity
    const snapshot = Snapshot.create({
      projectId,
      version: nextVersion,
      summary: summary || null,
      createdById: createdById || null,
      isAutomatic,
      files,
    });

    // 4. Attach label if provided
    let versionLabel: VersionLabel | null = null;
    if (label && label.trim()) {
      versionLabel = VersionLabel.create({
        projectId,
        snapshotId: snapshot.id,
        version: nextVersion,
        label: label.trim(),
        createdById,
      });
      snapshot.addLabel(versionLabel);
    }

    // 5. Persist snapshot & label
    const saved = await this.historyRepository.saveSnapshot(snapshot);
    if (versionLabel) {
      await this.historyRepository.saveLabel(versionLabel);
    }

    return saved;
  }
}
