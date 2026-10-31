import { BaseDomainException } from '@/modules/library/core/errors/domain.exception';

export {
  type AttachmentKind,
  type LinkMode,
  type AttachmentType,
  type AttachmentExtractionStatus,
  type AttachmentRevisionEntity,
  type AttachmentEntity,
  type CreateAttachmentInput,
} from '@/modules/library/core/types/extraction.types';

export class AttachmentInvariantError extends BaseDomainException {
  public override name = 'AttachmentInvariantError';
  constructor(message: string) {
    super(message);
  }
}

export class AttachmentStorageException extends BaseDomainException {
  constructor(message: string) {
    super(message);
  }
}
