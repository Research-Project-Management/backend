export interface LibraryNote {
  id: string;
  itemId?: string | null;
  title: string;
  content: string;
  tags?: string[];
  version: number;
  authorId?: string;
  createdAt: string;
  updatedAt: string;
}
