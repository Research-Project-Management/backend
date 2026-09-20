import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { Prisma, SuggestionStatus } from '@prisma/client';

export interface SuggestionWithAuthor {
  id: string;
  pageId: string;
  projectPageId: string | null;
  authorId: string;
  type: string;
  originalText: string;
  suggestedText: string;
  fromLine: number;
  fromColumn: number;
  toLine: number;
  toColumn: number;
  description: string | null;
  status: SuggestionStatus;
  resolvedById: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  author: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  };
}

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

function mapSuggestion(s: any): SuggestionWithAuthor {
  const { author, ...rest } = s;
  return {
    ...rest,
    author: {
      id: author.id,
      email: author.email,
      name: author.profile?.name ?? 'User',
      avatar: author.profile?.avatar ?? null,
    },
  };
}

@Injectable()
export class SuggestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.PageSuggestionCreateInput,
  ): Promise<SuggestionWithAuthor> {
    const res = await this.prisma.pageSuggestion.create({
      data,
      include: {
        author: {
          select: AUTHOR_SELECT,
        },
      },
    });
    return mapSuggestion(res);
  }

  async findById(id: string): Promise<SuggestionWithAuthor | null> {
    const res = await this.prisma.pageSuggestion.findFirst({
      where: { id, deletedAt: null },
      include: {
        author: {
          select: AUTHOR_SELECT,
        },
      },
    });
    return res ? mapSuggestion(res) : null;
  }

  async findByPageId(
    pageId: string,
    status?: SuggestionStatus,
  ): Promise<SuggestionWithAuthor[]> {
    const list = await this.prisma.pageSuggestion.findMany({
      where: {
        OR: [{ pageId }, { projectPageId: pageId }],
        deletedAt: null,
        ...(status ? { status } : {}),
      },
      orderBy: [{ fromLine: 'asc' }, { createdAt: 'desc' }],
      include: {
        author: {
          select: AUTHOR_SELECT,
        },
      },
    });
    return list.map(mapSuggestion);
  }

  async update(
    id: string,
    data: Prisma.PageSuggestionUpdateInput,
  ): Promise<SuggestionWithAuthor> {
    const res = await this.prisma.pageSuggestion.update({
      where: { id },
      data,
      include: {
        author: {
          select: AUTHOR_SELECT,
        },
      },
    });
    return mapSuggestion(res);
  }

  async updateStatusMany(
    ids: string[],
    status: SuggestionStatus,
    resolvedById: string,
  ): Promise<number> {
    const res = await this.prisma.pageSuggestion.updateMany({
      where: {
        id: { in: ids },
        deletedAt: null,
      },
      data: {
        status,
        resolvedById,
        resolvedAt: new Date(),
      },
    });
    return res.count;
  }
}
