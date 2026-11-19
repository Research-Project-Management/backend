import type { KnowledgeDocumentItem } from '../types/knowledge.type';

export interface StorageFileKnowledgeRow {
  id: string;
  spaceId: string;
  createdById: string;
  filename: string;
  mimeType: string;
  size: bigint;
  metadata: unknown;
  createdAt: Date;
}

export function readMetadataRecord(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  return {};
}

export function mapStorageFileToKnowledgeItem(
  file: StorageFileKnowledgeRow,
): KnowledgeDocumentItem {
  const meta = readMetadataRecord(file.metadata);
  const title =
    typeof meta.title === 'string' && meta.title.trim()
      ? meta.title
      : file.filename;
  const ragDocId =
    typeof meta.ragDocId === 'string' && meta.ragDocId.trim()
      ? meta.ragDocId
      : file.id;
  const chunkCount = typeof meta.chunkCount === 'number' ? meta.chunkCount : 0;
  const status =
    typeof meta.ragStatus === 'string' ? meta.ragStatus : undefined;
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((t): t is string => typeof t === 'string')
    : typeof meta.tags === 'string'
      ? meta.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];

  return {
    id: ragDocId,
    name: file.filename,
    title,
    size: Number(file.size || 0),
    chunk_count: chunkCount,
    tags,
    type: file.mimeType,
    created_at:
      file.createdAt instanceof Date
        ? file.createdAt.toISOString()
        : String(file.createdAt),
    user_id: file.createdById,
    status,
  };
}
