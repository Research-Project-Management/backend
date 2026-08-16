export interface SearchResultItem {
  type: 'project' | 'task' | 'paper' | 'page' | 'file' | 'folder' | 'sticky';
  id: string;
  name: string;
  identifier?: string;
  projectId?: string | null;
  projectName?: string | null;
  icon?: string | null;
  color?: string | null;
  mimeType?: string | null;
  size?: number | null;
  updatedAt: Date;
}
