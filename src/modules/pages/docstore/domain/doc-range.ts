/**
 * modules/manuscripts/docstore/domain/doc-range.ts
 * Value Object managing Track Changes and Inline Comments line coordinates.
 * Matches Overleaf RangeManager.js data structures.
 */

export interface RangeMetadata {
  ts?: string | Date;
  user_id?: string;
  [key: string]: unknown;
}

export interface TrackChangeItem {
  id: string;
  metadata?: RangeMetadata;
  [key: string]: unknown;
}

export interface CommentItem {
  id: string;
  op?: {
    t?: string;
    [key: string]: unknown;
  };
  metadata?: RangeMetadata;
  [key: string]: unknown;
}

export interface ReviewRoundInfo {
  status:
    | 'draft'
    | 'in_review'
    | 'changes_requested'
    | 'approved'
    | 'submitted'
    | 'locked';
  roundNumber?: number;
  requestedById?: string;
  requestedAt?: string;
  verdictById?: string;
  verdictAt?: string;
  notes?: string;
  deadline?: string;
  [key: string]: unknown;
}

export interface DocRanges {
  changes?: TrackChangeItem[];
  comments?: CommentItem[];
  review?: ReviewRoundInfo;
  [key: string]: unknown;
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
                ts: change.metadata.ts
                  ? new Date(change.metadata.ts).toISOString()
                  : undefined,
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
                ts: comment.metadata.ts
                  ? new Date(comment.metadata.ts).toISOString()
                  : undefined,
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
