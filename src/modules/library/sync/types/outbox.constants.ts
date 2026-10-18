import { libraryConfig } from '../../core/config/library.config';

export const LIBRARY_OUTBOX_QUEUE = libraryConfig().outbox.queue;
export const LIBRARY_OUTBOX_JOB = 'dispatch_outbox_event';
