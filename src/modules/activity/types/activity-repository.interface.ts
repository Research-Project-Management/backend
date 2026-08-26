/**
 * Activity Domain Repository Interfaces (Ports)
 *
 * Implements Hexagonal / DDD-Lite Architecture decoupling Prisma models from services.
 */

import { ActivityEvent, EntityType, Prisma } from '@prisma/client';
import { DomainActivityEvent } from '../events/activity.events';

export const ACTOR_MINIMAL_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type ActivityEventWithActor = Prisma.ActivityEventGetPayload<{
  include: {
    actor: { select: typeof ACTOR_MINIMAL_SELECT };
    project: { select: { id: true; name: true } };
  };
}>;

export interface IActivityRepository {
  create(event: DomainActivityEvent): Promise<ActivityEvent>;
  findWorkspaceFeed(
    workspaceId: string,
    options?: {
      projectId?: string;
      entityType?: EntityType;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ items: ActivityEventWithActor[]; total: number }>;
  findEntityFeed(
    entityType: EntityType,
    entityId: string,
    limit?: number,
  ): Promise<ActivityEventWithActor[]>;
  findRecentByActor(
    workspaceId: string,
    actorId: string,
    limit?: number,
  ): Promise<ActivityEvent[]>;
  findEntitiesTitleMap(
    taskIds: string[],
    paperIds: string[],
    pageIds: string[],
  ): Promise<Map<string, string>>;
  findFallbackRecentItems(
    workspaceId: string,
    userId: string,
    limit: number,
  ): Promise<{
    tasks: Array<{
      id: string;
      title: string;
      projectId: string;
      updatedAt: Date;
    }>;
    papers: Array<{ id: string; title: string; updatedAt: Date }>;
    pages: Array<{
      id: string;
      title: string;
      projectId: string;
      updatedAt: Date;
    }>;
  }>;
}
