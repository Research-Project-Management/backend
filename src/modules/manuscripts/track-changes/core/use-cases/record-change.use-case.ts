/**
 * track-changes/core/use-cases/record-change.use-case.ts
 * Inbound Use Case recording a new proposed inline text change (insert or delete).
 */

import { Injectable } from '@nestjs/common';
import { ITrackChangesRepositoryPort } from '../ports/track-changes-repository.port';
import { IRealtimeNotifierPort } from '../ports/realtime-notifier.port';
import { TrackChange, ChangeType } from '../domain/entities/track-change.entity';
import { TextRangeVo, TextRangeProps } from '../domain/value-objects/text-range.vo';

export interface RecordChangeInput {
  projectId: string;
  docId: string;
  type: ChangeType;
  text: string;
  range: TextRangeProps;
  userId?: string | null;
}

@Injectable()
export class RecordChangeUseCase {
  constructor(
    private readonly repository: ITrackChangesRepositoryPort,
    private readonly notifier: IRealtimeNotifierPort,
  ) {}

  public async execute(input: RecordChangeInput): Promise<TrackChange> {
    const { projectId, docId, type, text, range, userId } = input;

    const change = TrackChange.create({
      projectId,
      docId,
      type,
      text,
      range: TextRangeVo.create(range),
      createdById: userId,
    });

    const saved = await this.repository.saveChange(change);
    this.notifier.notifyChangeRecorded(projectId, docId, saved);

    return saved;
  }
}
