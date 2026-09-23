/**
 * track-changes/core/domain/value-objects/change-metadata.vo.ts
 * Value Object capturing authorship and timestamp context for a change or comment.
 */

export interface ChangeMetadataProps {
  createdById?: string | null;
  authorName?: string | null;
  authorColor?: string | null;
  createdAt?: Date;
}

export class ChangeMetadataVo {
  public readonly createdById: string | null;
  public readonly authorName: string;
  public readonly authorColor: string;
  public readonly createdAt: Date;

  constructor(props: ChangeMetadataProps) {
    this.createdById = props.createdById ?? null;
    this.authorName = props.authorName || 'Collaborator';
    this.authorColor = props.authorColor || '#3b82f6';
    this.createdAt = props.createdAt ?? new Date();
  }

  public toJSON(): Record<string, any> {
    return {
      createdById: this.createdById,
      authorName: this.authorName,
      authorColor: this.authorColor,
      createdAt: this.createdAt.toISOString(),
    };
  }
}
