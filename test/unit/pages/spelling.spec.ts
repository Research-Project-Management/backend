import { SpellingService } from '@/modules/pages/spelling';
import {
  SpellingEngine,
  normalizeLanguageCode,
} from '@/modules/pages/spelling/domain/spelling.engine';
import { UnsupportedLanguageException } from '@/modules/pages/spelling/domain/spelling.errors';
import type { SpellingRepository } from '@/modules/pages/spelling/spelling.repository';

describe('Pages Spelling Seam', () => {
  const engine = new SpellingEngine();

  it('checks English words, deduplicates batch inputs, honors custom dictionaries, and skips suggest() on long garbage tokens', async () => {
    const report = await engine.checkWords(
      [
        'Transformers',
        'revolutionized',
        'natural',
        'languge',
        'processing',
        'complexity',
      ],
      'en-US',
    );
    expect(report.misspelledCount).toBe(1);
    expect(report.errors[0].word).toBe('languge');
    expect(report.errors[0].suggestions).toContain('language');

    const batchReport = await engine.checkWords(
      ['algorithm', 'neurosymbolic', 'algoritm', 'algorithm'],
      'en-US',
      new Set(['neurosymbolic']),
    );
    expect(batchReport.totalWordsChecked).toBe(3);
    expect(batchReport.misspelledCount).toBe(1);
    expect(batchReport.errors[0].word).toBe('algoritm');

    const longToken = 'a'.repeat(55);
    const dosGuardReport = await engine.checkWords([longToken], 'en-US');
    expect(dosGuardReport.misspelledCount).toBe(1);
    expect(dosGuardReport.errors[0].suggestions).toEqual([]);
  });

  it('loads Vietnamese, French, German, and Spanish Hunspell dictionaries concurrently', async () => {
    const [fr, de, es, vi] = await Promise.all([
      engine.checkWords(['bonjour', 'algorithme', 'bonjorr'], 'fr-FR'),
      engine.checkWords(
        ['Wissenschaft', 'Forschung', 'Wissenschaaft'],
        'de-DE',
      ),
      engine.checkWords(['investigación', 'algoritmo', 'algoritmox'], 'es-ES'),
      engine.checkWords(['học', 'nghiên', 'cứu', 'xyzqwert'], 'vi-VN'),
    ]);

    expect(fr.errors.map((e) => e.word)).toEqual(['bonjorr']);
    expect(de.errors.map((e) => e.word)).toEqual(['Wissenschaaft']);
    expect(es.errors.map((e) => e.word)).toEqual(['algoritmox']);
    expect(vi.errors.map((e) => e.word)).toEqual(['xyzqwert']);
  });

  it('caches project dictionary in L1, coalesces cold loads via Singleflight, and invalidates on learnWord', async () => {
    const words = ['fluxcustom'];
    const mockRepo = {
      listWords: jest.fn(
        () =>
          new Promise<string[]>((resolve) =>
            setTimeout(() => resolve([...words]), 15),
          ),
      ),
      addWord: jest.fn(async (_p: string, w: string) => {
        words.push(w);
      }),
      removeWord: jest.fn(async () => true),
    } as unknown as SpellingRepository;

    const svc = new SpellingService(mockRepo, engine);

    const parallelReports = await Promise.all(
      Array.from({ length: 6 }, () =>
        svc.check('p1', { words: ['fluxcustom'], language: 'en-US' }),
      ),
    );
    expect(parallelReports.every((r) => r.misspelledCount === 0)).toBe(true);
    expect(mockRepo.listWords).toHaveBeenCalledTimes(1);

    await svc.learnWord('p1', 'myterm', 'u1');
    const afterLearn = await svc.check('p1', {
      words: ['myterm'],
      language: 'en-US',
    });
    expect(afterLearn.misspelledCount).toBe(0);
    expect(mockRepo.listWords).toHaveBeenCalledTimes(2);
  });

  it('normalizes underscore locales to BCP-47 and short-circuits "off" or invalid tags before DB queries', async () => {
    expect(normalizeLanguageCode('en_US')).toBe('en-US');
    expect(normalizeLanguageCode('fr_FR')).toBe('fr-FR');
    expect(normalizeLanguageCode('OFF')).toBe('off');

    const mockRepo = {
      listWords: jest.fn(async () => ['custom']),
    } as unknown as SpellingRepository;
    const svc = new SpellingService(mockRepo, engine);

    expect(
      await svc.check('p1', { words: ['misspelledxyz'], language: 'off' }),
    ).toEqual({
      language: 'off',
      totalWordsChecked: 0,
      misspelledCount: 0,
      errors: [],
    });
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
  });
});
