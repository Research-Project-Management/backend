export interface ListItemsQuery {
  userId: string;
  view?:
    'all' | 'recent' | 'unfiled' | 'trash' | 'my-publications' | 'publications';
  collectionId?: string;
  tagId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
  projectId?: string;
}
