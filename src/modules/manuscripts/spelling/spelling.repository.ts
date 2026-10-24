/**
 * modules/manuscripts/spelling/spelling.repository.ts
 * Direct Prisma repository for custom project & user spelling dictionaries.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ManuscriptDictionaryScope } from '@prisma/client';

@Injectable()
export class SpellingRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async listProjectWords(projectId: string): Promise<string[]> {
    const records = await this.prisma.manuscriptCustomWord.findMany({
      where: { projectId, scope: ManuscriptDictionaryScope.project },
      select: { word: true },
      orderBy: { word: 'asc' },
    });
    return records.map((r: { word: string }) => r.word);
  }

  public async listUserWords(userId: string): Promise<string[]> {
    const records = await this.prisma.manuscriptCustomWord.findMany({
      where: { userId, scope: ManuscriptDictionaryScope.user },
      select: { word: true },
      orderBy: { word: 'asc' },
    });
    return records.map((r: { word: string }) => r.word);
  }

  public async addProjectWord(projectId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    const existing = await this.prisma.manuscriptCustomWord.findFirst({
      where: {
        scope: ManuscriptDictionaryScope.project,
        projectId,
        userId: null,
        word: clean,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await this.prisma.manuscriptCustomWord.create({
          data: {
            scope: ManuscriptDictionaryScope.project,
            projectId,
            userId: null,
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

    const existing = await this.prisma.manuscriptCustomWord.findFirst({
      where: {
        scope: ManuscriptDictionaryScope.user,
        projectId: null,
        userId,
        word: clean,
      },
      select: { id: true },
    });

    if (!existing) {
      try {
        await this.prisma.manuscriptCustomWord.create({
          data: {
            scope: ManuscriptDictionaryScope.user,
            projectId: null,
            userId,
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
    const res = await this.prisma.manuscriptCustomWord.deleteMany({
      where: {
        projectId,
        word: clean,
        scope: ManuscriptDictionaryScope.project,
      },
    });
    return res.count > 0;
  }

  public async removeUserWord(userId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    const res = await this.prisma.manuscriptCustomWord.deleteMany({
      where: { userId, word: clean, scope: ManuscriptDictionaryScope.user },
    });
    return res.count > 0;
  }
}
