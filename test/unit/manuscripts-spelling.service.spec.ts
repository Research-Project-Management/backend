/**
 * test/unit/manuscripts-spelling.service.spec.ts
 * Comprehensive Unit Test Suite for Manuscripts Spelling Subsystem
 * Testing LaTeX Tokenizer (Space-Preserving Masking), Academic Spell Engine,
 * Levenshtein-Damerau Suggestions, Custom Dictionaries, Use Cases, Service & Controllers.
 */

import {
  LanguageCodeVo,
  WordTokenVo,
  DictionaryScopeVo,
  MisspelledWord,
  SpellingReport,
  UnsupportedLanguageException,
  InvalidWordException,
  RegexLatexTokenizerAdapter,
  AcademicSpellEngineAdapter,
  InMemoryCustomDictionaryAdapter,
  CheckSpellingUseCase,
  GetSuggestionsUseCase,
  LearnWordUseCase,
  UnlearnWordUseCase,
  ListCustomWordsUseCase,
  SpellingService,
  SpellingController,
  SpellingUtilityController,
} from '@/modules/manuscripts/spelling';
import { BadRequestException } from '@nestjs/common';

describe('Manuscripts Spelling Subsystem (LaTeX Tokenizer, Engine & Custom Dictionaries)', () => {
  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('LanguageCodeVo', () => {
      it('should create valid language codes and normalize format', () => {
        const en = LanguageCodeVo.create('en-US');
        expect(en.code).toBe('en-us');
        expect(en.baseLanguage).toBe('en');
        expect(en.isEnglish()).toBe(true);

        const vi = LanguageCodeVo.create('vi_VN');
        expect(vi.code).toBe('vi-vn');
        expect(vi.baseLanguage).toBe('vi');
        expect(vi.isEnglish()).toBe(false);
      });

      it('should default to en-us when undefined or empty string provided', () => {
        const def1 = LanguageCodeVo.create();
        expect(def1.code).toBe('en-us');

        const def2 = LanguageCodeVo.create('');
        expect(def2.code).toBe('en-us');
      });

      it('should throw UnsupportedLanguageException on unknown language', () => {
        expect(() => LanguageCodeVo.create('klingon')).toThrow(UnsupportedLanguageException);
      });
    });

    describe('WordTokenVo', () => {
      it('should construct token with coordinates and normalized text', () => {
        const token = new WordTokenVo({
          word: 'Transformer',
          line: 5,
          col: 12,
        });

        expect(token.word).toBe('Transformer');
        expect(token.normalized).toBe('transformer');
        expect(token.line).toBe(5);
        expect(token.col).toBe(12);
        expect(token.length).toBe(11);
      });

      it('should throw InvalidWordException on empty word token', () => {
        expect(() => new WordTokenVo({ word: '  ', line: 1, col: 1 })).toThrow(InvalidWordException);
      });
    });

    describe('DictionaryScopeVo', () => {
      it('should instantiate project and user scopes correctly', () => {
        const projectScope = DictionaryScopeVo.project();
        expect(projectScope.isProject()).toBe(true);
        expect(projectScope.isUser()).toBe(false);

        const userScope = DictionaryScopeVo.user();
        expect(userScope.isUser()).toBe(true);
        expect(userScope.isProject()).toBe(false);
      });

      it('should parse case-insensitively from string', () => {
        expect(DictionaryScopeVo.fromString('user').isUser()).toBe(true);
        expect(DictionaryScopeVo.fromString('PROJECT').isProject()).toBe(true);
        expect(DictionaryScopeVo.fromString('unknown').isProject()).toBe(true);
      });
    });

    describe('MisspelledWord & SpellingReport Entities', () => {
      it('should create MisspelledWord and serialize to JSON', () => {
        const err = new MisspelledWord({
          word: 'recieved',
          line: 3,
          col: 10,
          length: 8,
          suggestions: ['received'],
        });

        expect(err.word).toBe('recieved');
        expect(err.suggestions).toEqual(['received']);
        const json = err.toJSON();
        expect(json.line).toBe(3);
        expect(json.col).toBe(10);
      });

      it('should create SpellingReport and calculate total errors', () => {
        const err1 = new MisspelledWord({ word: 'teh', line: 1, col: 1, length: 3, suggestions: ['the'] });
        const err2 = new MisspelledWord({ word: 'wrok', line: 1, col: 5, length: 4, suggestions: ['work'] });

        const report = new SpellingReport({
          language: 'en-us',
          totalWordsChecked: 25,
          errors: [err1, err2],
        });

        expect(report.totalWordsChecked).toBe(25);
        expect(report.misspelledCount).toBe(2);
        expect(report.toJSON().errors).toHaveLength(2);
      });
    });
  });

  // =========================================================================
  // 2. ADAPTERS LAYER
  // =========================================================================
  describe('Adapters Layer', () => {
    describe('RegexLatexTokenizerAdapter', () => {
      let tokenizer: RegexLatexTokenizerAdapter;

      beforeEach(() => {
        tokenizer = new RegexLatexTokenizerAdapter();
      });

      it('should extract plain prose words with accurate 1-indexed coordinates', () => {
        const text = 'Hello world from LaTeX.';
        const tokens = tokenizer.tokenize(text);

        expect(tokens.map((t) => t.word)).toEqual(['Hello', 'world', 'from', 'LaTeX']);
        expect(tokens[0]!.line).toBe(1);
        expect(tokens[0]!.col).toBe(1);
        expect(tokens[1]!.col).toBe(7); // 'world' starts at index 6 -> col 7
      });

      it('should mask inline and display math without affecting coordinate alignment', () => {
        // "We have $x + y = z$ in equation."
        //  12345678901234567890123456789012
        const text = 'We have $x + y = z$ in equation.';
        const tokens = tokenizer.tokenize(text);

        const words = tokens.map((t) => t.word);
        expect(words).toContain('We');
        expect(words).toContain('have');
        expect(words).toContain('in');
        expect(words).toContain('equation');
        expect(words).not.toContain('x');
        expect(words).not.toContain('y');
        expect(words).not.toContain('z');

        const inToken = tokens.find((t) => t.word === 'in');
        expect(inToken).toBeDefined();
        expect(inToken!.col).toBe(21); // 'in' is at index 20 -> col 21
      });

      it('should mask LaTeX commands with technical arguments (cite, ref, label)', () => {
        const text = 'As shown in \\cite{vaswani2017} and \\ref{sec:1}, attention works.';
        const tokens = tokenizer.tokenize(text);

        const words = tokens.map((t) => t.word);
        expect(words).not.toContain('vaswani2017');
        expect(words).not.toContain('sec');
        expect(words).toContain('attention');
        expect(words).toContain('works');
      });

      it('should preserve prose words inside styling commands like textbf and textit', () => {
        const text = 'This is a \\textbf{crucial} and \\textit{important} finding.';
        const tokens = tokenizer.tokenize(text);

        const words = tokens.map((t) => t.word);
        expect(words).toContain('crucial');
        expect(words).toContain('important');
        expect(words).toContain('finding');
      });

      it('should mask entire multiline math environments', () => {
        const text = `
Here is an equation:
\\begin{equation}
  E = m c^2 + \\alpha
\\end{equation}
The result is valid.
        `.trim();

        const tokens = tokenizer.tokenize(text);
        const words = tokens.map((t) => t.word);

        expect(words).toContain('Here');
        expect(words).toContain('equation');
        expect(words).not.toContain('alpha');
        expect(words).toContain('result');
        expect(words).toContain('valid');
      });

      it('should ignore text inside comments (%)', () => {
        const text = 'Valid text. % misspelled wrdd here should be ignored';
        const tokens = tokenizer.tokenize(text);

        const words = tokens.map((t) => t.word);
        expect(words).toContain('Valid');
        expect(words).toContain('text');
        expect(words).not.toContain('wrdd');
      });

      it('should return empty list on blank or whitespace text', () => {
        expect(tokenizer.tokenize('')).toEqual([]);
        expect(tokenizer.tokenize('   \n\t  ')).toEqual([]);
      });
    });

    describe('AcademicSpellEngineAdapter', () => {
      let engine: AcademicSpellEngineAdapter;
      const langEn = LanguageCodeVo.create('en-US');

      beforeEach(() => {
        engine = new AcademicSpellEngineAdapter();
      });

      it('should recognize academic and standard English vocabulary', () => {
        expect(engine.isCorrect('algorithm', langEn)).toBe(true);
        expect(engine.isCorrect('transformer', langEn)).toBe(true);
        expect(engine.isCorrect('hypothesis', langEn)).toBe(true);
        expect(engine.isCorrect('manuscript', langEn)).toBe(true);
        expect(engine.isCorrect('latex', langEn)).toBe(true);
        expect(engine.isCorrect('convolutional', langEn)).toBe(true);
      });

      it('should flag misspelled words', () => {
        expect(engine.isCorrect('recieved', langEn)).toBe(false);
        expect(engine.isCorrect('teh', langEn)).toBe(false);
        expect(engine.isCorrect('algoritm', langEn)).toBe(false);
      });

      it('should generate accurate Levenshtein-Damerau suggestions', () => {
        const sug1 = engine.getSuggestions('recieved', langEn);
        expect(sug1).toContain('received');

        const sug2 = engine.getSuggestions('teh', langEn);
        expect(sug2).toContain('the');

        const sug3 = engine.getSuggestions('algoritm', langEn);
        expect(sug3).toContain('algorithm');
      });

      it('should preserve capitalization in suggestions', () => {
        const suggestions = engine.getSuggestions('Recieved', langEn);
        expect(suggestions).toContain('Received');
      });

      it('should return empty suggestions for correctly spelled words', () => {
        expect(engine.getSuggestions('algorithm', langEn)).toEqual([]);
      });
    });

    describe('InMemoryCustomDictionaryAdapter', () => {
      let dict: InMemoryCustomDictionaryAdapter;

      beforeEach(() => {
        dict = new InMemoryCustomDictionaryAdapter();
      });

      it('should add, list, and verify project words', async () => {
        await dict.addProjectWord('proj-1', 'ResNet');
        await dict.addProjectWord('proj-1', 'BioBERT');

        const list = await dict.listProjectWords('proj-1');
        expect(list).toEqual(['biobert', 'resnet']);

        expect(await dict.isCustomWord('resnet', 'proj-1')).toBe(true);
        expect(await dict.isCustomWord('unknown', 'proj-1')).toBe(false);
      });

      it('should add, list, and verify user words', async () => {
        await dict.addUserWord('user-1', 'MyCustomTerm');

        const list = await dict.listUserWords('user-1');
        expect(list).toEqual(['mycustomterm']);

        expect(await dict.isCustomWord('mycustomterm', undefined, 'user-1')).toBe(true);
      });

      it('should remove words from project and user scopes', async () => {
        await dict.addProjectWord('proj-1', 'dropme');
        expect(await dict.removeProjectWord('proj-1', 'dropme')).toBe(true);
        expect(await dict.isCustomWord('dropme', 'proj-1')).toBe(false);
      });
    });
  });

  // =========================================================================
  // 3. USE CASES LAYER
  // =========================================================================
  describe('Use Cases Layer', () => {
    let tokenizer: RegexLatexTokenizerAdapter;
    let spellEngine: AcademicSpellEngineAdapter;
    let customDict: InMemoryCustomDictionaryAdapter;

    beforeEach(() => {
      tokenizer = new RegexLatexTokenizerAdapter();
      spellEngine = new AcademicSpellEngineAdapter();
      customDict = new InMemoryCustomDictionaryAdapter();
    });

    describe('CheckSpellingUseCase', () => {
      it('should check LaTeX document and report misspelled words with suggestions', async () => {
        const useCase = new CheckSpellingUseCase(tokenizer, spellEngine, customDict);

        const latex = 'This paper presents a novel neural netwrok architecture.';
        const report = await useCase.execute({
          text: latex,
          language: 'en-US',
        });

        expect(report.totalWordsChecked).toBe(8);
        expect(report.misspelledCount).toBe(1);
        expect(report.errors[0]!.word).toBe('netwrok');
        expect(report.errors[0]!.suggestions).toContain('network');
      });

      it('should ignore custom words learned in project or user dictionary', async () => {
        await customDict.addProjectWord('proj-1', 'FluxPlatform');
        await customDict.addUserWord('user-1', 'GigaBERT');

        const useCase = new CheckSpellingUseCase(tokenizer, spellEngine, customDict);
        const text = 'Testing FluxPlatform and GigaBERT models.';

        const report = await useCase.execute({
          text,
          projectId: 'proj-1',
          userId: 'user-1',
        });

        expect(report.misspelledCount).toBe(0);
      });

      it('should return empty report on blank text', async () => {
        const useCase = new CheckSpellingUseCase(tokenizer, spellEngine, customDict);
        const report = await useCase.execute({ text: '' });
        expect(report.totalWordsChecked).toBe(0);
        expect(report.misspelledCount).toBe(0);
      });
    });

    describe('GetSuggestionsUseCase', () => {
      it('should return suggestions for single word query', () => {
        const useCase = new GetSuggestionsUseCase(spellEngine);
        const suggestions = useCase.execute({ word: 'hypotheis' });
        expect(suggestions).toContain('hypothesis');
      });

      it('should return empty for empty word', () => {
        const useCase = new GetSuggestionsUseCase(spellEngine);
        expect(useCase.execute({ word: '' })).toEqual([]);
      });
    });

    describe('LearnWordUseCase & UnlearnWordUseCase', () => {
      it('should learn and unlearn project words', async () => {
        const learnUseCase = new LearnWordUseCase(customDict);
        const unlearnUseCase = new UnlearnWordUseCase(customDict);

        await learnUseCase.execute({ word: 'TransformerXL', scope: 'PROJECT', projectId: 'p1' });
        expect(await customDict.isCustomWord('transformerxl', 'p1')).toBe(true);

        const removed = await unlearnUseCase.execute({ word: 'TransformerXL', scope: 'PROJECT', projectId: 'p1' });
        expect(removed).toBe(true);
        expect(await customDict.isCustomWord('transformerxl', 'p1')).toBe(false);
      });

      it('should reject invalid words containing spaces or illegal characters', async () => {
        const learnUseCase = new LearnWordUseCase(customDict);
        await expect(
          learnUseCase.execute({ word: 'two words', scope: 'PROJECT', projectId: 'p1' })
        ).rejects.toThrow(InvalidWordException);

        await expect(
          learnUseCase.execute({ word: '', scope: 'PROJECT', projectId: 'p1' })
        ).rejects.toThrow(InvalidWordException);
      });
    });

    describe('ListCustomWordsUseCase', () => {
      it('should list words in requested scope', async () => {
        await customDict.addProjectWord('p1', 'AlphaWord');
        await customDict.addProjectWord('p1', 'BetaWord');

        const useCase = new ListCustomWordsUseCase(customDict);
        const words = await useCase.execute({ scope: 'PROJECT', projectId: 'p1' });
        expect(words).toEqual(['alphaword', 'betaword']);
      });
    });
  });

  // =========================================================================
  // 4. SERVICE & CONTROLLER INTEGRATION LAYER
  // =========================================================================
  describe('Service & Controller Integration Layer', () => {
    let service: SpellingService;
    let controller: SpellingController;
    let utilityController: SpellingUtilityController;
    let customDict: InMemoryCustomDictionaryAdapter;
    let docstoreMock: any;

    beforeEach(() => {
      const tokenizer = new RegexLatexTokenizerAdapter();
      const spellEngine = new AcademicSpellEngineAdapter();
      customDict = new InMemoryCustomDictionaryAdapter();

      const checkSpellingUseCase = new CheckSpellingUseCase(tokenizer, spellEngine, customDict);
      const getSuggestionsUseCase = new GetSuggestionsUseCase(spellEngine);
      const learnWordUseCase = new LearnWordUseCase(customDict);
      const unlearnWordUseCase = new UnlearnWordUseCase(customDict);
      const listCustomWordsUseCase = new ListCustomWordsUseCase(customDict);

      docstoreMock = {
        getDoc: jest.fn(),
      };

      service = new SpellingService(
        checkSpellingUseCase,
        getSuggestionsUseCase,
        learnWordUseCase,
        unlearnWordUseCase,
        listCustomWordsUseCase,
        docstoreMock
      );

      controller = new SpellingController(service);
      utilityController = new SpellingUtilityController(service);
    });

    describe('SpellingController (Project Scoped)', () => {
      it('POST /projects/:projectId/spelling/check should check spelling via text payload', async () => {
        const req = { user: { id: 'u1' } };
        const res = await controller.checkSpelling(
          'p1',
          { text: 'An algorithim test.', language: 'en-US' },
          req
        );

        expect(res.totalWordsChecked).toBe(3);
        expect(res.misspelledCount).toBe(1);
        expect(res.errors[0]!.word).toBe('algorithim');
      });

      it('POST /projects/:projectId/spelling/check should load doc from Docstore when docId provided', async () => {
        docstoreMock.getDoc.mockResolvedValue({
          lines: ['First line with a mistakke.', 'Second clean line.'],
        });

        const req = { user: { id: 'u1' } };
        const res = await controller.checkSpelling('p1', { docId: 'doc-1' }, req);

        expect(docstoreMock.getDoc).toHaveBeenCalledWith('p1', 'doc-1');
        expect(res.misspelledCount).toBe(1);
        expect(res.errors[0]!.word).toBe('mistakke');
      });

      it('POST /projects/:projectId/spelling/dictionary/learn should learn word and GET /dictionary list it', async () => {
        await controller.learnProjectWord('p1', { word: 'SpecialJargon' });

        const list = await controller.listProjectDictionary('p1');
        expect(list.scope).toBe('PROJECT');
        expect(list.words).toContain('specialjargon');

        // Delete word
        const delRes = await controller.unlearnProjectWord('p1', 'SpecialJargon');
        expect(delRes.removed).toBe(true);

        const listAfter = await controller.listProjectDictionary('p1');
        expect(listAfter.words).not.toContain('specialjargon');
      });

      it('should translate domain exceptions to HTTP 400 BadRequestException', async () => {
        const req = { user: { id: 'u1' } };
        await expect(
          controller.checkSpelling('p1', { text: 'test', language: 'unsupported-lang' }, req)
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('SpellingUtilityController', () => {
      it('GET /spelling/suggestions should return suggestions for word', () => {
        const res = utilityController.getSuggestions({ word: 'recieved' });
        expect(res.word).toBe('recieved');
        expect(res.suggestions).toContain('received');
      });

      it('GET & POST /spelling/user-dictionary should manage user personal words', async () => {
        const req = { user: { id: 'u-personal' } };

        await utilityController.learnUserWord({ word: 'MyPersonalToken' }, req);
        const list = await utilityController.listUserDictionary(req);

        expect(list.scope).toBe('USER');
        expect(list.words).toContain('mypersonaltoken');

        const del = await utilityController.unlearnUserWord('MyPersonalToken', req);
        expect(del.removed).toBe(true);
      });
    });
  });
});
