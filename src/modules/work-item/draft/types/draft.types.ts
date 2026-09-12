import { TaskPriority } from '@prisma/client';

export interface DraftAuthor {
  id: string;
  name: string;
  email: string | null;
  avatar: string | null;
}

export interface WorkItemDraftItem {
  id: string;
  title: string;
  content: string | null;
  description: string | null;
  columnId: string | null;
  priority: TaskPriority;
  startDate: Date | null;
  dueDate: Date | null;
  labels: string[];
  assigneeId: string | null;
  assigneeIds: any;
  metadata: any;
  projectId: string | null;
  project?: {
    id: string;
    name: string;
    identifier: string | null;
  } | null;
  authorId: string;
  author?: DraftAuthor | null;
  createdAt: Date;
  updatedAt: Date;
}
