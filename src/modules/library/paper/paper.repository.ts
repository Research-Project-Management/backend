import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma } from '@prisma/client';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  avatar: true,
} as const;

export type PaperWithRelations = Prisma.PaperGetPayload<{
  include: {
    uploadedBy: {
      select: typeof USER_SELECT;
    };
    collection: true;
    attachments: true;
  };
}>;

@Injectable()
export class PaperRepository {
  constructor(public readonly prisma: PrismaService) {}

  async resolveWorkspace(workspaceIdOrSlug: string) {
    return this.prisma.workspace.findFirst({
      where: {
        OR: [{ id: workspaceIdOrSlug }, { url: workspaceIdOrSlug }],
      },
      select: { id: true },
    });
  }

  async findPapers(
    where: Prisma.PaperWhereInput,
    options?: {
      skip?: number;
      take?: number;
      orderBy?: Prisma.PaperOrderByWithRelationInput[];
    },
  ) {
    return this.prisma.paper.findMany({
      where,
      include: {
        uploadedBy: { select: USER_SELECT },
        collection: {
          select: { id: true, name: true, color: true },
        },
        attachments: true,
      },
      orderBy: options?.orderBy || { createdAt: 'desc' },
      take: options?.take,
      skip: options?.skip,
    });
  }

  async countPapers(where: Prisma.PaperWhereInput): Promise<number> {
    return this.prisma.paper.count({ where });
  }

  async findPaperById(paperId: string) {
    return this.prisma.paper.findUnique({
      where: { id: paperId },
      include: {
        uploadedBy: { select: USER_SELECT },
        collection: true,
        attachments: true,
      },
    });
  }

  async createPaper(
    data: Prisma.PaperCreateInput | Prisma.PaperUncheckedCreateInput,
  ) {
    return this.prisma.paper.create({
      data: data as Prisma.PaperCreateInput,
      include: {
        uploadedBy: { select: USER_SELECT },
        collection: true,
        attachments: true,
      },
    });
  }

  async updatePaper(
    paperId: string,
    data: Prisma.PaperUpdateInput | Prisma.PaperUncheckedUpdateInput,
  ) {
    return this.prisma.paper.update({
      where: { id: paperId },
      data: data,
      include: {
        uploadedBy: { select: USER_SELECT },
        collection: true,
        attachments: true,
      },
    });
  }

  async createAttachment(
    data:
      | Prisma.PaperAttachmentCreateInput
      | Prisma.PaperAttachmentUncheckedCreateInput,
  ) {
    return this.prisma.paperAttachment.create({
      data: data as Prisma.PaperAttachmentCreateInput,
    });
  }

  async deleteAttachment(attachmentId: string) {
    return this.prisma.paperAttachment.delete({
      where: { id: attachmentId },
    });
  }

  /**
   * Deterministically resolve unique citationKey within workspace
   */
  async resolveUniqueCitationKey(
    workspaceId: string,
    baseKey: string,
    excludePaperId?: string,
  ): Promise<string> {
    const existing = await this.prisma.paper.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        citationKey: {
          startsWith: baseKey,
        },
        ...(excludePaperId && { id: { not: excludePaperId } }),
      },
      select: { citationKey: true },
    });

    const keySet = new Set(existing.map((p) => p.citationKey));
    if (!keySet.has(baseKey)) {
      return baseKey;
    }

    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < alphabet.length; i++) {
      const candidate = `${baseKey}${alphabet[i]}`;
      if (!keySet.has(candidate)) {
        return candidate;
      }
    }

    return `${baseKey}-${Date.now().toString(36)}`;
  }
}

