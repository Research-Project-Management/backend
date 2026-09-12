export enum ReadingStatus {
  UNREAD = 'unread',
  READING = 'reading',
  COMPLETED = 'completed',
}

export type StateStatus = ReadingStatus;
export const StateStatus = ReadingStatus;

export interface StateData {
  readStatus: ReadingStatus;
  rating: number;
  lastReadAt: string | null;
}

export type ItemState = StateData;
export type ReadingState = StateData;

export const VALID_READING_TRANSITIONS: Record<
  ReadingStatus,
  readonly ReadingStatus[]
> = {
  [ReadingStatus.UNREAD]: [ReadingStatus.READING, ReadingStatus.COMPLETED],
  [ReadingStatus.READING]: [ReadingStatus.COMPLETED, ReadingStatus.UNREAD],
  [ReadingStatus.COMPLETED]: [ReadingStatus.READING, ReadingStatus.UNREAD],
};

export const VALID_STATE_TRANSITIONS = VALID_READING_TRANSITIONS;
