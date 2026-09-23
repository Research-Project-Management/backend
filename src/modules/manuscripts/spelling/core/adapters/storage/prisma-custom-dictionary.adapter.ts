/**
 * spelling/core/adapters/storage/prisma-custom-dictionary.adapter.ts
 * Driven Adapter implementing ICustomDictionaryRepositoryPort using PostgreSQL via Prisma.
 * Includes graceful memory fallback if database table is not yet migrated in local dev.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service';
import { ICustomDictionaryRepositoryPort } from '../../ports/custom-dictionary-repository.port';

@Injectable()
export class PrismaCustomDictionaryAdapter implements ICustomDictionaryRepositoryPort {
  private readonly logger = new Logger(PrismaCustomDictionaryAdapter.name);
  private readonly memoryFallback = new Map<string, Set<string>>();

  constructor(private readonly prisma: PrismaService) {}

  public async listProjectWords(projectId: string): Promise<string[]> {
    try {
      const records = await (this.prisma as any).manuscriptCustomWord.findMany({
        where: { projectId, scope: 'project' },
        select: { word: true },
        orderBy: { word: 'asc' },
      });
      return records.map((r: any) => r.word);
    } catch {
      const set = this.memoryFallback.get(`p:${projectId}`);
      return set ? Array.from(set).sort() : [];
    }
  }

  public async listUserWords(userId: string): Promise<string[]> {
    try {
      const records = await (this.prisma as any).manuscriptCustomWord.findMany({
        where: { userId, scope: 'user' },
        select: { word: true },
        orderBy: { word: 'asc' },
      });
      return records.map((r: any) => r.word);
    } catch {
      const set = this.memoryFallback.get(`u:${userId}`);
      return set ? Array.from(set).sort() : [];
    }
  }

  public async addProjectWord(projectId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    try {
      await (this.prisma as any).manuscriptCustomWord.upsert({
        where: {
          projectId_word: { projectId, word: clean },
        },
        create: {
          scope: 'project',
          projectId,
          word: clean,
        },
        update: {},
      });
    } catch {
      let set = this.memoryFallback.get(`p:${projectId}`);
      if (!set) {
        set = new Set<string>();
        this.memoryFallback.set(`p:${projectId}`, set);
      }
      set.add(clean);
    }
  }

  public async addUserWord(userId: string, word: string): Promise<void> {
    const clean = word.toLowerCase().trim();
    if (!clean) return;

    try {
      await (this.prisma as any).manuscriptCustomWord.upsert({
        where: {
          userId_word: { userId, word: clean },
        },
        create: {
          scope: 'user',
          userId,
          word: clean,
        },
        update: {},
      });
    } catch {
      let set = this.memoryFallback.get(`u:${userId}`);
      if (!set) {
        set = new Set<string>();
        this.memoryFallback.set(`u:${userId}`, set);
      }
      set.add(clean);
    }
  }

  public async removeProjectWord(projectId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    try {
      const res = await (this.prisma as any).manuscriptCustomWord.deleteMany({
        where: { projectId, word: clean, scope: 'project' },
      });
      return res.count > 0;
    } catch {
      const set = this.memoryFallback.get(`p:${projectId}`);
      return set ? set.delete(clean) : false;
    }
  }

  public async removeUserWord(userId: string, word: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    try {
      const res = await (this.prisma as any).manuscriptCustomWord.deleteMany({
        where: { userId, word: clean, scope: 'user' },
      });
      return res.count > 0;
    } catch {
      const set = this.memoryFallback.get(`u:${userId}`);
      return set ? set.delete(clean) : false;
    }
  }

  public async isCustomWord(word: string, projectId?: string, userId?: string): Promise<boolean> {
    const clean = word.toLowerCase().trim();
    if (!clean) return false;

    // Check project scope
    if (projectId) {
      try {
        const count = await (this.prisma as any).manuscriptCustomWord.count({
          where: { projectId, word: clean, scope: 'project' },
        });
        if (count > 0) return true;
      } catch {
        const pSet = this.memoryFallback.get(`p:${projectId}`);
        if (pSet && pSet.has(clean)) return true;
      }
    }

    // Check user scope
    if (userId) {
      try {
        const count = await (this.prisma as any).manuscriptCustomWord.count({
          where: { userId, word: clean, scope: 'user' },
        });
        if (count > 0) return true;
      } catch {
        const uSet = this.memoryFallback.get(`u:${userId}`);
        if (uSet && uSet.has(clean)) return true;
      }
    }

    return false;
  }
}
