/**
 * modules/manuscripts/spelling/spelling.repository.ts
 * Direct Prisma repository for custom project & user spelling dictionaries.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';

@Injectable()
export class SpellingRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async listProjectWords(projectId: string): Promise<string[]> {
    const records = await this.prisma.customDictionaryWord.findMany({
      where: { spaceId: projectId },
      select: { word: true },
      orderBy: { word: 'asc' },
    });
    return records.map((r: { word: string }) => r.word);
  }

  public async listUserWords(userId: string): Promise<string[]> {
    const records = await this.prisma.customDictionaryWord.findMany({
      where: { spaceId: userId },
      select: { word: true },
      orderBy: { word: 'asc' },
    });
    return records.map((r: { word: string }) => r.word);
  }

  public async addProjectWord(projectId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    const existing = await this.prisma.customDictionaryWord.findFirst({
      where: {
        spaceId: projectId,
        word: clean,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await this.prisma.customDictionaryWord.create({
          data: {
            spaceId: projectId,
            word: clean,
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== 'P2002') {
          throw err;
        }
      }
    }
  }

  public async addUserWord(userId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    const existing = await this.prisma.customDictionaryWord.findFirst({
      where: {
        spaceId: userId,
        word: clean,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await this.prisma.customDictionaryWord.create({
          data: {
            spaceId: userId,
            createdById: userId,
            word: clean,
          },
        });
      } catch (err: unknown) {
        if ((err as { code?: string })?.code !== 'P2002') {
          throw err;
        }
      }
    }
  }

  public async removeProjectWord(
    projectId: string,
    word: string,
  ): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    const res = await this.prisma.customDictionaryWord.deleteMany({
      where: {
        spaceId: projectId,
        word: clean,
      },
    });
    return res.count > 0;
  }

  public async removeUserWord(userId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    const res = await this.prisma.customDictionaryWord.deleteMany({
      where: { spaceId: userId, word: clean },
    });
    return res.count > 0;
  }
}
