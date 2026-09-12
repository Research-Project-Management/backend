import { WorkItemUpdateStatus } from '../dto/update.dto';

export interface WorkItemUpdate {
  id: string;
  status: WorkItemUpdateStatus;
  comment?: string | null;
  authorId: string;
  createdAt: string;
}
