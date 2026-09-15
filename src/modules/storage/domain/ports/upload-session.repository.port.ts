import { UploadSession } from '../entities/upload-session.entity';
import { CompletedPart } from './storage-driver.port';

export interface IUploadSessionRepository {
  findById(id: string): Promise<UploadSession | null>;
  create(session: UploadSession): Promise<UploadSession>;
  update(session: UploadSession): Promise<UploadSession>;
  delete(id: string): Promise<void>;
  recordPart(
    sessionId: string,
    partNumber: number,
    etag: string,
    sizeBytes: number,
  ): Promise<void>;
  getParts(sessionId: string): Promise<CompletedPart[]>;
  findExpiredSessions(threshold: Date, limit: number): Promise<UploadSession[]>;
}
