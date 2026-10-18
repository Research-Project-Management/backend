/**
 * modules/manuscripts/spelling/spelling.repository.ts
 * Direct Prisma repository for custom project & user spelling dictionaries.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';
import { ManuscriptDictionaryScope } from '@prisma/client';
import { ICustomDictionaryRepositoryPort } from './domain';

@Injectable()
export class SpellingRepository implements ICustomDictionaryRepositoryPort {
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

    await this.prisma.manuscriptCustomWord.upsert({
      where: {
        projectId_word: { projectId, word: clean },
      },
      create: {
        scope: ManuscriptDictionaryScope.project,
        projectId,
        word: clean,
      },
      update: {},
    });
  }

  public async addUserWord(userId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    await this.prisma.manuscriptCustomWord.upsert({
      where: {
        userId_word: { userId, word: clean },
      },
      create: {
        scope: ManuscriptDictionaryScope.user,
        userId,
        word: clean,
      },
      update: {},
    });
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

  public async isCustomWord(
    word: string,
    projectId?: string,
    userId?: string,
  ): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    if (!clean) return false;

    if (projectId) {
      const count = await this.prisma.manuscriptCustomWord.count({
        where: {
          projectId,
          word: clean,
          scope: ManuscriptDictionaryScope.project,
        },
      });
      if (count > 0) return true;
    }

    if (userId) {
      const count = await this.prisma.manuscriptCustomWord.count({
        where: { userId, word: clean, scope: ManuscriptDictionaryScope.user },
      });
      if (count > 0) return true;
    }

    return false;
  }
}
