import { Injectable } from '@nestjs/common';
import { HistoryRepository } from '../history.repository';
import { VersionLabel } from '../domain/label';
import {
  VersionNotFoundException,
  DuplicateLabelException,
} from '../domain/errors';
import { VersionLabelDto } from '../dto/label.dto';

@Injectable()
export class LabelService {
  constructor(private readonly repository: HistoryRepository) {}

  public async listLabels(
    spaceId: string,
    pageId?: string,
  ): Promise<VersionLabelDto[]> {
    const labels = await this.repository.listLabels(spaceId, pageId);
    return labels.map((label) => label.toDto());
  }

  public async labelVersion(
    projectId: string,
    version: number,
    label: string,
    userId?: string | null,
    pageId?: string,
  ): Promise<VersionLabelDto> {
    const cleanLabel = label.trim();
    const [snapshot, existing] = await Promise.all([
      this.repository.findByVersion(projectId, version, pageId),
      this.repository.findLabelByName(projectId, cleanLabel, pageId),
    ]);
    if (!snapshot) {
      throw new VersionNotFoundException(projectId, version);
    }

    if (existing && existing.version !== version) {
      throw new DuplicateLabelException(projectId, cleanLabel);
    }

    const versionLabel =
      existing ??
      VersionLabel.create({
        projectId,
        spaceId: projectId,
        pageId: snapshot.pageId ?? pageId,
        snapshotId: snapshot.id,
        version,
        label: cleanLabel,
        createdById: userId || null,
      });

    if (existing) {
      versionLabel.updateLabel(cleanLabel);
    }

    const saved = await this.repository.saveLabel(versionLabel);
    return saved.toDto();
  }

  public async deleteLabel(
    projectId: string,
    labelId: string,
    pageId?: string,
  ): Promise<void> {
    await this.repository.deleteLabel(projectId, labelId, pageId);
  }
}
