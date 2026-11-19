export interface KnowledgeFileJobData {
  fileId: string;
  authorId: string;
  filename: string;
  mimeType: string;
  projectId?: string | null;
}

export interface KnowledgeDocumentItem {
  id: string;
  name: string;
  title: string;
  size: number;
  chunk_count: number;
  tags: string[];
  type?: string;
  created_at?: string;
  user_id?: string;
  status?: string;
}

export interface KnowledgeUploadResult {
  id: string;
  docId: string;
  name: string;
  title: string;
  size: number;
  chunk_count: number;
  pages_parsed: number;
  status: string;
  space_id: string;
}

export interface KnowledgeUploadOptions {
  spaceId?: string;
  chatId?: string;
  title?: string;
  tags?: string;
}
