/**
 * project-history/core/use-cases/label-version.use-case.ts
 * Inbound Use Case adding or updating a named label on a specific project version snapshot.
 */

import { Injectable } from '@nestjs/common';
import { IHistoryRepositoryPort } from '../ports/history-repository.port';
import { VersionLabel } from '../domain/entities/version-label.entity';
import { VersionNotFoundException } from '../domain/exceptions/version-not-found.exception';
import { DuplicateLabelException } from '../domain/exceptions/duplicate-label.exception';

export interface LabelVersionInput {
  projectId: string;
  version: number;
  label: string;
  createdById?: string | null;
}

@Injectable()
export class LabelVersionUseCase {
  constructor(private readonly historyRepository: IHistoryRepositoryPort) {}

  public async execute(input: LabelVersionInput): Promise<VersionLabel> {
    const { projectId, version, label, createdById } = input;
    const cleanLabel = label.trim();

    // 1. Verify that the target snapshot version exists
    const snapshot = await this.historyRepository.findByVersion(projectId, version);
    if (!snapshot) {
      throw new VersionNotFoundException(projectId, version);
    }

    // 2. Check if a label with this name already exists in this project
    const existing = await this.historyRepository.findLabelByName(projectId, cleanLabel);
    if (existing && existing.version !== version) {
      throw new DuplicateLabelException(projectId, cleanLabel);
    }

    // 3. Create or update the label entity
    const versionLabel = existing ?? VersionLabel.create({
      projectId,
      snapshotId: snapshot.id,
      version,
      label: cleanLabel,
      createdById: createdById || null,
    });

    if (existing) {
      versionLabel.updateLabel(cleanLabel);
    }

    return await this.historyRepository.saveLabel(versionLabel);
  }
}
