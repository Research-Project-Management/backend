import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import type { Prisma } from '@prisma/client';
import type { StorageFileKnowledgeRow } from './domain/knowledge.mapper';

@Injectable()
export class KnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findFileById(fileId: string) {
    if (!this.prisma.fileNode?.findUnique) return null;
    return this.prisma.fileNode
      .findUnique({
        where: { id: fileId },
      })
      .catch(() => null);
  }

  async updateFileMetadata(
    fileId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.prisma.fileNode?.update) return;
    await this.prisma.fileNode.update({
      where: { id: fileId },
      data: {
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  async listSpaceFiles(spaceId: string): Promise<StorageFileKnowledgeRow[]> {
    if (!this.prisma.fileNode?.findMany) return [];
    const rows = await this.prisma.fileNode
      .findMany({
        where: {
          spaceId,
          deletedAt: null,
          isFolder: false,
        },
        select: {
          id: true,
          spaceId: true,
          createdById: true,
          filename: true,
          mimeType: true,
          size: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      })
      .catch(() => []);
    return Array.isArray(rows) ? rows : [];
  }

  async findFilesBulk(
    ids: string[],
    spaceId: string,
  ): Promise<StorageFileKnowledgeRow[]> {
    if (!ids.length || !this.prisma.fileNode?.findMany) return [];
    const rows = await this.prisma.fileNode
      .findMany({
        where: {
          id: { in: ids },
          spaceId,
          deletedAt: null,
        },
        select: {
          id: true,
          spaceId: true,
          createdById: true,
          filename: true,
          mimeType: true,
          size: true,
          metadata: true,
          createdAt: true,
        },
      })
      .catch(() => []);
    return Array.isArray(rows) ? rows : [];
  }

  async findOwnedFileByDocId(
    docId: string,
    spaceId: string,
  ): Promise<StorageFileKnowledgeRow | null> {
    if (!this.prisma.fileNode?.findFirst) return null;
    return this.prisma.fileNode
      .findFirst({
        where: {
          spaceId,
          deletedAt: null,
          OR: [
            { id: docId },
            { metadata: { path: ['ragDocId'], equals: docId } },
          ],
        },
        select: {
          id: true,
          spaceId: true,
          createdById: true,
          filename: true,
          mimeType: true,
          size: true,
          metadata: true,
          createdAt: true,
        },
      })
      .catch(() => null);
  }
}
