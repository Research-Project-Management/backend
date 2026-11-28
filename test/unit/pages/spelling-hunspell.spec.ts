import {
  normalizeLanguageCode,
  SpellingEngine,
} from '@/modules/pages/spelling/domain/spelling.engine';
import { UnsupportedLanguageException } from '@/modules/pages/spelling/domain/spelling.errors';
import { SpellingService } from '@/modules/pages/spelling/spelling.service';
import type { SpellingRepository } from '@/modules/pages/spelling/spelling.repository';

describe('Pages Spelling - Async Hunspell Engine & Overleaf Protocol', () => {
  const engine = new SpellingEngine();

  it('checks English words accurately without false positives and suggests fixes', async () => {
    const report = await engine.checkWords(
      ['Transformers', 'revolutionized', 'natural', 'languge', 'processing', 'complexity'],
      'en-US',
    );
    expect(report.misspelledCount).toBe(1);
    expect(report.errors[0].word).toBe('languge');
    expect(report.errors[0].suggestions).toContain('language');
  });

  it('supports Overleaf-style words[] batch check with deduplication and custom dictionary', async () => {
    const custom = new Set(['neurosymbolic']);
    const report = await engine.checkWords(
      ['algorithm', 'neurosymbolic', 'algoritm', 'algorithm'],
      'en-US',
      custom,
    );
    expect(report.totalWordsChecked).toBe(3);
    expect(report.misspelledCount).toBe(1);
    expect(report.errors[0].word).toBe('algoritm');
    expect(report.errors[0].suggestions).toContain('algorithm');
  });

  it('skips expensive suggest() for overly long garbage tokens (CPU DoS guard)', async () => {
    const longToken = 'a'.repeat(55);
    const report = await engine.checkWords([longToken], 'en-US');
    expect(report.misspelledCount).toBe(1);
    expect(report.errors[0].word).toBe(longToken);
    expect(report.errors[0].suggestions).toEqual([]);
  });

  it('loads real Vietnamese, French, German, and Spanish Hunspell dictionaries concurrently', async () => {
    const [fr, de, es, vi] = await Promise.all([
      engine.checkWords(['bonjour', 'algorithme', 'bonjorr'], 'fr-FR'),
      engine.checkWords(['Wissenschaft', 'Forschung', 'Wissenschaaft'], 'de-DE'),
      engine.checkWords(['investigación', 'algoritmo', 'algoritmox'], 'es-ES'),
      engine.checkWords(['học', 'nghiên', 'cứu', 'xyzqwert'], 'vi-VN'),
    ]);

    expect(fr.errors.map((e) => e.word)).toEqual(['bonjorr']);
    expect(de.errors.map((e) => e.word)).toEqual(['Wissenschaaft']);
    expect(es.errors.map((e) => e.word)).toEqual(['algoritmox']);
    expect(vi.errors.map((e) => e.word)).toEqual(['xyzqwert']);
  });

  it('caches project dictionary as ReadonlySet in SpellingService and invalidates on learn/unlearn', async () => {
    const words = ['fluxcustom'];
    const mockRepo = {
      listWords: jest.fn(async () => [...words]),
      addWord: jest.fn(async (_p: string, w: string) => {
        words.push(w);
      }),
      removeWord: jest.fn(async () => true),
    } as unknown as SpellingRepository;

    const svc = new SpellingService(mockRepo, engine);

    // 2 checks -> only 1 DB call due to L1 LRU cache
    await svc.check('p1', { words: ['fluxcustom'], language: 'en-US' });
    const r2 = await svc.check('p1', { words: ['fluxcustom'], language: 'en-US' });
    expect(r2.misspelledCount).toBe(0);
    expect(mockRepo.listWords).toHaveBeenCalledTimes(1);

    // After learnWord, cache invalidates
    await svc.learnWord('p1', 'myterm', 'u1');
    const r3 = await svc.check('p1', { words: ['myterm'], language: 'en-US' });
    expect(r3.misspelledCount).toBe(0);
    expect(mockRepo.listWords).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold dictionary loads via Singleflight (1 DB query for N parallel checks)', async () => {
    const mockRepo = {
      listWords: jest.fn(
        () =>
          new Promise<string[]>((resolve) =>
            setTimeout(() => resolve(['singleflightword']), 20),
          ),
      ),
    } as unknown as SpellingRepository;

    const svc = new SpellingService(mockRepo, engine);
    const reports = await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.check('cold-space', { words: ['singleflightword'], language: 'en-US' }),
      ),
    );

    expect(mockRepo.listWords).toHaveBeenCalledTimes(1);
    expect(reports.every((r) => r.misspelledCount === 0)).toBe(true);
  });

  it('normalizes Prisma underscore locales (en_US, fr_FR) to BCP-47 and short-circuits "off" or invalid tags before DB queries', async () => {
    expect(normalizeLanguageCode('en_US')).toBe('en-US');
    expect(normalizeLanguageCode('fr_FR')).toBe('fr-FR');
    expect(normalizeLanguageCode('en-us')).toBe('en-US');
    expect(normalizeLanguageCode('OFF')).toBe('off');

    const mockRepo = {
      listWords: jest.fn(async () => ['custom']),
    } as unknown as SpellingRepository;
    const svc = new SpellingService(mockRepo, engine);

    const offReport = await svc.check('p1', {
      words: ['misspelledxyz'],
      language: 'off',
    });
    expect(offReport).toEqual({
      language: 'off',
      totalWordsChecked: 0,
      misspelledCount: 0,
      errors: [],
    });
    expect(mockRepo.listWords).not.toHaveBeenCalled();

    await expect(
      svc.check('p1', { words: ['hello'], language: 'xx_YY' }),
    ).rejects.toThrow(UnsupportedLanguageException);
    expect(mockRepo.listWords).not.toHaveBeenCalled();

    const prismaDefaultReport = await svc.check('p1', {
      words: ['algorithm', 'languge'],
      language: 'en_US',
    });
    expect(prismaDefaultReport.language).toBe('en-US');
    expect(prismaDefaultReport.misspelledCount).toBe(1);
    expect(mockRepo.listWords).toHaveBeenCalledTimes(1);
  });
});
