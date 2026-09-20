import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { EntityType, Prisma } from '@prisma/client';
import { CreateAttachmentDto } from './dto/create-attachment.dto';

const AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

function mapAttachment<
  T extends {
    author?: {
      id: string;
      email: string | null;
      profile?: { name: string; avatar: string | null } | null;
    } | null;
  },
>(attachment: T) {
  if (!attachment) return attachment;
  const { author, ...rest } = attachment;
  return {
    ...rest,
    author: author
      ? {
          id: author.id,
          email: author.email,
          name: author.profile?.name ?? 'User',
          avatar: author.profile?.avatar ?? null,
        }
      : null,
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
          select: AUTHOR_SELECT,
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
          select: AUTHOR_SELECT,
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
            select: AUTHOR_SELECT,
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
          select: AUTHOR_SELECT,
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
}
