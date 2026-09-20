/**
 * BullMQ Queue & Job Names for Realtime Document Collaboration
 *
 * Used for background collaborative checkpointing, version history diffs,
 * and persistent audit trail generation without blocking the WebSocket gateway.
 */

export const DOCUMENT_COLLABORATION_QUEUE = 'document-collaboration-queue';

export const DOCUMENT_COLLABORATIVE_CHECKPOINT_JOB =
  'create-collaborative-checkpoint';

export interface QueuedCheckpointJob {
  pageId: string;
  content: string;
  savedById?: string;
  label?: string;
  editsCount?: number;
}
