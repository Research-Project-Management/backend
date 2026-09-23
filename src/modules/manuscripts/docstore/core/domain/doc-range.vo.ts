/**
 * modules/manuscripts/docstore/core/domain/doc-range.vo.ts
 * Value Object managing Track Changes and Inline Comments line coordinates.
 * Matches Overleaf RangeManager.js data structures.
 */

export interface RangeMetadata {
  ts?: string | Date;
  user_id?: string;
  [key: string]: any;
}

export interface TrackChangeItem {
  id: string;
  metadata?: RangeMetadata;
  [key: string]: any;
}

export interface CommentItem {
  id: string;
  op?: {
    t?: string;
    [key: string]: any;
  };
  metadata?: RangeMetadata;
  [key: string]: any;
}

export interface DocRanges {
  changes?: TrackChangeItem[];
  comments?: CommentItem[];
  [key: string]: any;
}

export class DocRangeVo {
  public static normalize(ranges?: DocRanges | null): DocRanges {
    if (!ranges) {
      return { changes: [], comments: [] };
    }

    const changes = Array.isArray(ranges.changes)
      ? ranges.changes.map((change) => ({
          ...change,
          metadata: change.metadata
            ? {
                ...change.metadata,
                ts: change.metadata.ts ? new Date(change.metadata.ts).toISOString() : undefined,
              }
            : undefined,
        }))
      : [];

    const comments = Array.isArray(ranges.comments)
      ? ranges.comments.map((comment) => ({
          ...comment,
          metadata: comment.metadata
            ? {
                ...comment.metadata,
                ts: comment.metadata.ts ? new Date(comment.metadata.ts).toISOString() : undefined,
              }
            : undefined,
        }))
      : [];

    return { ...ranges, changes, comments };
  }

  public static areEqual(a?: DocRanges | null, b?: DocRanges | null): boolean {
    const normA = DocRangeVo.normalize(a);
    const normB = DocRangeVo.normalize(b);
    return JSON.stringify(normA) === JSON.stringify(normB);
  }
}
