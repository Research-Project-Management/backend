export type CreatorType =
  | 'author'
  | 'editor'
  | 'translator'
  | 'contributor'
  | 'advisor'
  | 'reviewer';

export interface CreatorCredit {
  id?: string;
  orderIndex: number;
  creatorType: CreatorType;
  firstName?: string;
  lastName?: string;
  fullName: string;
}

export interface CreatorCreditInput {
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  creatorType?: string;
  orderIndex?: number;
}

/** Backward compatibility alias for legacy imports during migration */
export type CreatorInput = CreatorCreditInput;
