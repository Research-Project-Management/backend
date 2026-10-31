import { Logger } from '@nestjs/common';
import { OutboxRepository } from '../repositories/outbox.repository';
import { ChangeLogRepository } from '../repositories/changelog.repository';
import { OutboxMetrics } from '../services/outbox.metrics';

export async function handleMissingOutboxHandler(params: {
  event: { id: string; eventType: string; retryCount: number };
  maxRetries: number;
  workerId: string;
  repo: OutboxRepository;
  logger: Logger;
  metricsService?: OutboxMetrics;
}): Promise<'deadLettered' | 'retried'> {
  const { event, maxRetries, workerId, repo, logger, metricsService } = params;
  const newRetryCount = event.retryCount + 1;
  metricsService?.incrementCounter('outbox_unhandled_event_total');

  if (newRetryCount >= maxRetries) {
    logger.error(
      `Unrecognized event type "${event.eventType}" on event ${event.id} reached max retries (${maxRetries}). Moving to DLQ.`,
    );
    metricsService?.incrementCounter('outbox_dlq_total');
    await repo.markDeadLetter(
      event.id,
      newRetryCount,
      `No handler registered for event type "${event.eventType}"`,
      workerId,
    );
    return 'deadLettered';
  }

  const delaySec = Math.pow(2, newRetryCount) * 10;
  logger.warn(
    `No handler registered for event type "${event.eventType}" on event ${event.id}. Retrying in ${delaySec}s (attempt ${newRetryCount}/${maxRetries})`,
  );
  await repo.scheduleRetry(
    event.id,
    newRetryCount,
    new Date(Date.now() + delaySec * 1000),
    `No handler registered for event type "${event.eventType}"`,
    workerId,
  );
  return 'retried';
}

export async function handleOutboxDispatchFailure(params: {
  event: { id: string; eventType: string; retryCount: number };
  err: unknown;
  maxRetries: number;
  workerId: string;
  repo: OutboxRepository;
  logger: Logger;
  metricsService?: OutboxMetrics;
}): Promise<'deadLettered' | 'retried'> {
  const { event, err, maxRetries, workerId, repo, logger, metricsService } =
    params;
  const newRetryCount = event.retryCount + 1;
  const errMsg = err instanceof Error ? err.message : String(err);
  metricsService?.incrementCounter('outbox_retry_total');

  if (newRetryCount >= maxRetries) {
    logger.error(
      `Event ${event.id} (${event.eventType}) reached max retries (${maxRetries}). Moving to FAILED / DLQ: ${errMsg}`,
    );
    metricsService?.incrementCounter('outbox_dlq_total');
    await repo.markDeadLetter(
      event.id,
      newRetryCount,
      errMsg || 'Exceeded maximum retry attempts',
      workerId,
    );
    return 'deadLettered';
  }

  const delaySec = Math.pow(2, newRetryCount);
  const nextSchedule = new Date(Date.now() + delaySec * 1000);

  logger.warn(
    `Event ${event.id} (${event.eventType}) failed (attempt ${newRetryCount}/${maxRetries}). Retrying in ${delaySec}s: ${errMsg}`,
  );

  await repo.scheduleRetry(
    event.id,
    newRetryCount,
    nextSchedule,
    errMsg,
    workerId,
  );
  return 'retried';
}

export async function executeOutboxGarbageCollection(params: {
  repo: OutboxRepository;
  changeLogRepo?: ChangeLogRepository;
  logger: Logger;
}): Promise<{
  purgedPublished: number;
  purgedFailed: number;
  purgedChanges: number;
  purgedTombstones: number;
}> {
  const { repo, changeLogRepo, logger } = params;
  let purgedPublished = 0;
  let purgedFailed = 0;
  let purgedChanges = 0;
  let purgedTombstones = 0;

  try {
    const outboxRes = await repo.purgeProcessedOutboxEvents(3, 30, 1000);
    purgedPublished = outboxRes.purgedPublished;
    purgedFailed = outboxRes.purgedFailed;

    if (changeLogRepo) {
      const changeLogRes = await changeLogRepo.compactAndPurgeChangeLog(
        30,
        1000,
      );
      purgedChanges = changeLogRes.purgedChanges;
      purgedTombstones = changeLogRes.purgedTombstones;
    }
    if (
      purgedPublished > 0 ||
      purgedFailed > 0 ||
      purgedChanges > 0 ||
      purgedTombstones > 0
    ) {
      logger.log(
        `[OutboxGC] Purged ${purgedPublished} published outbox events, ${purgedFailed} failed outbox events, ${purgedChanges} change log entries, and ${purgedTombstones} tombstones.`,
      );
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`Outbox database GC sweep encountered error: ${errMsg}`);
  }

  return {
    purgedPublished,
    purgedFailed,
    purgedChanges,
    purgedTombstones,
  };
}

export async function buildOutboxDiagnosticSummary(params: {
  workerId: string;
  registeredHandlers: string[];
  hasHandler: (eventType: string) => boolean;
  hasDefaultHandler: boolean;
  repo: OutboxRepository;
  metricsService?: OutboxMetrics;
}): Promise<{
  workerId: string;
  registeredHandlers: string[];
  pendingCountsByType: Record<string, number>;
  totalPending: number;
  totalProcessing: number;
  oldestPendingAgeSeconds: number;
  unhandledEventTypes: string[];
}> {
  const {
    workerId,
    registeredHandlers,
    hasHandler,
    hasDefaultHandler,
    repo,
    metricsService,
  } = params;
  const now = new Date();
  const pendingCountsByType: Record<string, number> = {};
  let totalPending = 0;
  let oldestPendingAgeSeconds = 0;
  const unhandledSet = new Set<string>();

  const { groupedPending, oldestPendingCreatedAt, processingCount } =
    await repo.getDiagnosticData();

  if (oldestPendingCreatedAt) {
    oldestPendingAgeSeconds = Math.max(
      0,
      Math.floor((now.getTime() - oldestPendingCreatedAt.getTime()) / 1000),
    );
  }

  for (const group of groupedPending) {
    pendingCountsByType[group.eventType] = group.count;
    totalPending += group.count;
    if (!hasHandler(group.eventType) && !hasDefaultHandler) {
      unhandledSet.add(group.eventType);
    }
  }

  metricsService?.setGauge('outbox_pending_total', totalPending);
  metricsService?.setGauge('outbox_processing_total', processingCount);
  metricsService?.setGauge(
    'outbox_oldest_pending_age_seconds',
    oldestPendingAgeSeconds,
  );

  return {
    workerId,
    registeredHandlers,
    pendingCountsByType,
    totalPending,
    totalProcessing: processingCount,
    oldestPendingAgeSeconds,
    unhandledEventTypes: Array.from(unhandledSet),
  };
}

export const OutboxEventHandlers = {
  handleMissingOutboxHandler,
  handleOutboxDispatchFailure,
  executeOutboxGarbageCollection,
  buildOutboxDiagnosticSummary,
};
