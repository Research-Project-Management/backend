import { AttachmentAggregate } from '../model/attachment.aggregate';

export const ATTACHMENT_REPOSITORY_PORT = Symbol('ATTACHMENT_REPOSITORY_PORT');

export interface IAttachmentRepositoryPort {
  save(aggregate: AttachmentAggregate): Promise<void>;
  findById(attachmentId: string): Promise<AttachmentAggregate | null>;
  findByItemId(itemId: string): Promise<AttachmentAggregate[]>;
  delete(attachmentId: string): Promise<void>;
}
