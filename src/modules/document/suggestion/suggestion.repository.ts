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

@Injectable()
export class SuggestionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.PageSuggestionCreateInput,
  ): Promise<SuggestionWithAuthor> {
    return this.prisma.pageSuggestion.create({
      data,
      include: {
        author: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    }) as unknown as Promise<SuggestionWithAuthor>;
  }

  async findById(id: string): Promise<SuggestionWithAuthor | null> {
    return this.prisma.pageSuggestion.findFirst({
      where: { id, deletedAt: null },
      include: {
        author: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    }) as unknown as Promise<SuggestionWithAuthor | null>;
  }

  async findByPageId(
    pageId: string,
    status?: SuggestionStatus,
  ): Promise<SuggestionWithAuthor[]> {
    return this.prisma.pageSuggestion.findMany({
      where: {
        OR: [{ pageId }, { projectPageId: pageId }],
        deletedAt: null,
        ...(status ? { status } : {}),
      },
      orderBy: [{ fromLine: 'asc' }, { createdAt: 'desc' }],
      include: {
        author: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    }) as unknown as Promise<SuggestionWithAuthor[]>;
  }

  async update(
    id: string,
    data: Prisma.PageSuggestionUpdateInput,
  ): Promise<SuggestionWithAuthor> {
    return this.prisma.pageSuggestion.update({
      where: { id },
      data,
      include: {
        author: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    }) as unknown as Promise<SuggestionWithAuthor>;
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
