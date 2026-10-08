/**
 * Branded ID types — Matt Pocock pattern.
 * Re-exports from central CoreModule for DRY canonical definition across Library domain.
 */
export {
  Brand,
  AnnotationId,
  AttachmentId,
  UserId,
  ItemId,
  asAnnotationId,
  asAttachmentId,
  asUserId,
  asItemId,
} from '../../../shared-kernel/core/types/branded.types';
