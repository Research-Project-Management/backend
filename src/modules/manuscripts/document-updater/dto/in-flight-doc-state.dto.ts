/**
 * document-updater/dto/in-flight-doc-state.dto.ts
 */

import { InFlightDoc } from '../core/domain/entities/in-flight-doc.entity';

export class InFlightDocStateDto {
  docId!: string;
  projectId!: string;
  lines!: string[];
  rev!: number;
  inFlightSeq!: number;
  status!: string;
  isDirty!: boolean;
  pendingOpsCount!: number;
  lastUpdateTimestamp!: number;
  isBuffered!: boolean;

  public static fromEntity(doc: InFlightDoc, isBuffered = true): InFlightDocStateDto {
    const dto = new InFlightDocStateDto();
    dto.docId = doc.docId;
    dto.projectId = doc.projectId;
    dto.lines = doc.lines;
    dto.rev = doc.rev;
    dto.inFlightSeq = doc.inFlightSeq;
    dto.status = doc.status.value;
    dto.isDirty = doc.isDirty;
    dto.pendingOpsCount = doc.pendingOpsCount;
    dto.lastUpdateTimestamp = doc.lastUpdateTimestamp;
    dto.isBuffered = isBuffered;
    return dto;
  }
}
