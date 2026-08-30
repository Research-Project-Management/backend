export enum ReadingStatus {
  UNREAD = 'unread',
  READING = 'reading',
  COMPLETED = 'completed',
}

export interface ReadingState {
  readStatus: ReadingStatus;
  rating: number;
  lastReadAt: string | null;
}
