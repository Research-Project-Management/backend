/**
 * document-updater/dto/flush-result.dto.ts
 */

export class FlushResultDto {
  projectId!: string;
  flushedDocsCount!: number;
  flushedDocIds!: string[];
  skippedDocIds!: string[];
  errors!: Array<{ docId: string; error: string }>;
  durationMs!: number;
}
