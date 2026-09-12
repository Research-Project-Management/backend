import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType, Prisma } from '@prisma/client';
import { CreateAttachmentDto } from './dto/create-attachment.dto';

@Injectable()
export class AttachmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateAttachmentDto, authorId?: string) {
    return this.prisma.entityAttachment.create({
      data: {
        entityType: data.entityType,
        entityId: data.entityId,
        workspaceId: data.workspaceId,
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
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findById(id: string) {
    return this.prisma.entityAttachment.findUnique({
      where: { id },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
  }

  async findMany(
    where: {
      entityType?: EntityType;
      entityId?: string;
      workspaceId?: string;
      projectId?: string;
    },
    skip = 0,
    take = 50,
  ) {
    const filter: Prisma.EntityAttachmentWhereInput = {
      ...(where.entityType && { entityType: where.entityType }),
      ...(where.entityId && { entityId: where.entityId }),
      ...(where.workspaceId && { workspaceId: where.workspaceId }),
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
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
            },
          },
        },
      }),
    ]);

    return { total, items };
  }

  async findByEntity(entityType: EntityType, entityId: string) {
    return this.prisma.entityAttachment.findMany({
      where: {
        entityType,
        entityId,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });
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
}
