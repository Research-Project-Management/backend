import { Injectable } from '@nestjs/common';
import { PrismaService, isUuid } from '@/core';
import { EntityType, Prisma } from '@prisma/client';
import { CreateAttachmentDto } from './dto/create-attachment.dto';
import {
  USER_MINIMAL_SELECT,
  mapUserMinimal,
  UserProfileSource,
} from '@/modules/work-item/common/types/shared.types';

function mapAttachment<T extends { author?: UserProfileSource | null }>(
  attachment: T,
) {
  if (!attachment) return attachment;
  const { author, ...rest } = attachment;
  return {
    ...rest,
    author: mapUserMinimal(author),
  };
}

@Injectable()
export class AttachmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateAttachmentDto, authorId?: string) {
    const res = await this.prisma.entityAttachment.create({
      data: {
        entityType: data.entityType,
        entityId: data.entityId,
        projectId: data.projectId,
        filename: data.filename,
        url: data.url,
        storageKey: data.storageKey,
        size: data.size || 0,
        mimeType: data.mimeType || 'application/octet-stream',
        metadata: (data.metadata || {}) as Prisma.InputJsonValue,
        authorId,
      },
      include: {
        author: {
          select: USER_MINIMAL_SELECT,
        },
      },
    });
    return mapAttachment(res);
  }

  async findById(id: string) {
    const res = await this.prisma.entityAttachment.findUnique({
      where: { id },
      include: {
        author: {
          select: USER_MINIMAL_SELECT,
        },
      },
    });
    return res ? mapAttachment(res) : null;
  }

  async findMany(
    where: {
      entityType?: EntityType;
      entityId?: string;
      projectId?: string;
    },
    skip = 0,
    take = 50,
  ) {
    const filter: Prisma.EntityAttachmentWhereInput = {
      ...(where.entityType && { entityType: where.entityType }),
      ...(where.entityId && { entityId: where.entityId }),
      ...(where.projectId && { projectId: where.projectId }),
    };

    const [total, items] = await Promise.all([
      this.prisma.entityAttachment.count({ where: filter }),
      this.prisma.entityAttachment.findMany({
        where: filter,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          author: {
            select: USER_MINIMAL_SELECT,
          },
        },
      }),
    ]);

    return { total, items: items.map(mapAttachment) };
  }

  async findByEntity(entityType: EntityType, entityId: string) {
    const items = await this.prisma.entityAttachment.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: USER_MINIMAL_SELECT,
        },
      },
    });
    return items.map(mapAttachment);
  }

  async delete(id: string) {
    return this.prisma.entityAttachment.delete({
      where: { id },
    });
  }

  async deleteByEntity(entityType: EntityType, entityId: string) {
    return this.prisma.entityAttachment.deleteMany({
      where: {
        entityType,
        entityId,
      },
    });
  }

  async findWorkItem(workItemId: string) {
    if (isUuid(workItemId) || !this.prisma.workItem?.findFirst) {
      return this.prisma.workItem.findUnique({
        where: { id: workItemId },
        select: { id: true, projectId: true },
      });
    }
    return this.prisma.workItem.findFirst({
      where: {
        identifier: { equals: workItemId, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true, projectId: true },
    });
  }

  async findWorkItemWithDetails(id: string) {
    return this.prisma.workItem.findUnique({
      where: { id },
      include: {
        assignee: {
          select: USER_MINIMAL_SELECT,
        },
        state: {
          select: {
            id: true,
            name: true,
            color: true,
            group: true,
            sequence: true,
          },
        },
        labelAssignments: {
          select: {
            label: { select: { id: true, name: true, color: true } },
          },
        },
      },
    });
  }

  async upsertEntityLink(
    workItemId: string,
    entityType: EntityType,
    entityId: string,
    description?: string,
  ) {
    if (!this.prisma.workItemEntityLink) return null;
    return this.prisma.workItemEntityLink.upsert({
      where: {
        workItemId_entityType_entityId: {
          workItemId,
          entityType,
          entityId,
        },
      },
      create: {
        workItemId,
        entityType,
        entityId,
        description,
      },
      update: {
        description,
      },
    });
  }

  async deleteEntityLink(
    workItemId: string,
    entityType: EntityType,
    entityId: string,
  ) {
    if (!this.prisma.workItemEntityLink) return null;
    return this.prisma.workItemEntityLink.deleteMany({
      where: {
        workItemId,
        entityType,
        entityId,
      },
    });
  }

  async findLinkedWorkItems(entityType: EntityType, entityId: string) {
    if (!this.prisma.workItemEntityLink) return [];
    return this.prisma.workItemEntityLink.findMany({
      where: {
        entityType,
        entityId,
      },
      include: {
        workItem: {
          select: {
            id: true,
            identifier: true,
            title: true,
            columnId: true,
            state: true,
            priority: true,
            projectId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
