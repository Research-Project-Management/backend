import { Injectable, Logger } from '@nestjs/common';
import { OutboxDispatchHandler } from '../../sync-core/outbox.worker';
import { OutboxEvent } from '@prisma/client';
import { PrismaService } from '../../../../core/database/prisma.service';
import { ZoteroPullWorker } from './zotero-pull.worker';
import { ZoteroReconcileWorker } from './zotero-reconcile.worker';

export interface ZoteroStreamEventPayload {
  bindingId: string;
  topic?: string;
  event?: 'updated' | 'deleted' | 'topicUpdated' | 'catchUp';
  version?: number;
  idempotencyKey?: string;
  timestamp?: string;
}

@Injectable()
export class ZoteroStreamOutboxHandler implements OutboxDispatchHandler {
  private readonly logger = new Logger(ZoteroStreamOutboxHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pullWorker: ZoteroPullWorker,
    private readonly reconcileWorker: ZoteroReconcileWorker,
  ) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as unknown as ZoteroStreamEventPayload;
    if (!payload || !payload.bindingId) {
      throw new Error(
        `Invalid Zotero stream event payload for event ${event.id}: missing bindingId`,
      );
    }

    const binding = await this.prisma.zoteroBinding.findUnique({
      where: { id: payload.bindingId },
      include: { connection: true },
    });

    if (!binding) {
      this.logger.warn(
        `Zotero binding ${payload.bindingId} not found. Skipping stream event ${event.id}.`,
      );
      return;
    }

    if (binding.connection && binding.connection.status !== 'active') {
      this.logger.warn(
        `Zotero connection for binding ${payload.bindingId} is inactive (${binding.connection.status}). Skipping stream event.`,
      );
      return;
    }

    this.logger.log(
      `Processing durable Zotero stream event [${payload.event || 'updated'}] for workspace ${binding.workspaceId}, binding ${binding.id} (topic: ${payload.topic || 'n/a'})`,
    );

    if (payload.event === 'deleted') {
      await this.reconcileWorker.executeReconciliation(
        binding.workspaceId,
        binding.id,
      );
    } else {
      await this.pullWorker.executePull(binding.workspaceId, binding.id);
    }
  }
}
