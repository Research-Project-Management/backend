/**
 * spelling/spelling.repository.ts
 * Prisma repository for project-scoped custom spelling dictionaries.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core';

@Injectable()
export class SpellingRepository {
  constructor(private readonly prisma: PrismaService) {}

  public async listWords(spaceId: string): Promise<string[]> {
    const records = await this.prisma.spellingWord.findMany({
      where: { spaceId },
      select: { word: true },
      orderBy: { word: 'asc' },
    });
    return records.map((record: { word: string }) => record.word);
  }

  public async addWord(
    spaceId: string,
    word: string,
    createdById?: string,
  ): Promise<void> {
    const normalizedWord = word.toLowerCase().trim();
    if (!normalizedWord) return;

    await this.prisma.spellingWord.createMany({
      data: [{ spaceId, word: normalizedWord, createdById: createdById ?? null }],
      skipDuplicates: true,
    });
  }

  public async removeWord(spaceId: string, word: string): Promise<boolean> {
    const normalizedWord = word.toLowerCase().trim();
    if (!normalizedWord) return false;

    const result = await this.prisma.spellingWord.deleteMany({
      where: { spaceId, word: normalizedWord },
    });
    return result.count > 0;
  }
}
