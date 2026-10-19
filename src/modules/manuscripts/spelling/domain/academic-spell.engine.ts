/**
 * modules/manuscripts/spelling/domain/academic-spell.engine.ts
 * Pure domain AcademicSpellEngine & LatexProseTokenizer.
 * Zero I/O, zero NestJS imports.
 */

import { InvalidWordException } from './invalid-word.exception';
import { UnsupportedLanguageException } from './unsupported-language.exception';
import {
  ACADEMIC_SHARED_WORDS,
  ENGLISH_COMMON_WORDS,
  VIETNAMESE_COMMON_WORDS,
  FRENCH_ACADEMIC_WORDS,
  GERMAN_ACADEMIC_WORDS,
  SPANISH_ACADEMIC_WORDS,
} from './academic-dictionaries';

export class LanguageCodeVo {
  private static readonly SUPPORTED_CODES = new Set([
    'en',
    'en-us',
    'en-gb',
    'en-ca',
    'vi',
    'vi-vn',
    'fr',
    'fr-fr',
    'de',
    'de-de',
    'es',
    'es-es',
  ]);

  public readonly code: string;
  public readonly baseLanguage: string;

  private constructor(normalizedCode: string) {
    this.code = normalizedCode;
    this.baseLanguage = normalizedCode.split('-')[0] || normalizedCode;
  }

  public static create(raw?: string): LanguageCodeVo {
    if (!raw || raw.trim() === '') {
      return new LanguageCodeVo('en-us');
    }

    const normalized = raw.trim().toLowerCase().replace('_', '-');
    if (!LanguageCodeVo.SUPPORTED_CODES.has(normalized)) {
      throw new UnsupportedLanguageException(raw);
    }

    return new LanguageCodeVo(normalized);
  }

  public isEnglish(): boolean {
    return this.baseLanguage === 'en';
  }

  public equals(other: LanguageCodeVo): boolean {
    return this.code === other.code;
  }

  public toString(): string {
    return this.code;
  }
}

export interface WordTokenProps {
  word: string;
  line: number;
  col: number;
  length?: number;
}

export class WordTokenVo {
  public readonly word: string;
  public readonly normalized: string;
  public readonly line: number;
  public readonly col: number;
  public readonly length: number;

  constructor(props: WordTokenProps) {
    if (!props.word || props.word.trim() === '') {
      throw new InvalidWordException(props.word, 'Word token cannot be empty');
    }

    this.word = props.word;
    this.normalized = props.word.toLowerCase();
    this.line = Math.max(1, props.line);
    this.col = Math.max(1, props.col);
    this.length = props.length || props.word.length;
  }

  public toJSON() {
    return {
      word: this.word,
      line: this.line,
      col: this.col,
      length: this.length,
    };
  }
}

export type WordToken = WordTokenVo;

export interface MisspelledWordProps {
  word: string;
  line: number;
  col: number;
  length: number;
  suggestions?: string[];
}

export class MisspelledWord {
  public readonly word: string;
  public readonly line: number;
  public readonly col: number;
  public readonly length: number;
  public readonly suggestions: readonly string[];

  constructor(props: MisspelledWordProps) {
    this.word = props.word;
    this.line = props.line;
    this.col = props.col;
    this.length = props.length;
    this.suggestions = Object.freeze(
      props.suggestions ? [...props.suggestions] : [],
    );
  }

  public toJSON() {
    return {
      word: this.word,
      line: this.line,
      col: this.col,
      length: this.length,
      suggestions: [...this.suggestions],
    };
  }
}

export interface SpellingReportProps {
  language: string;
  totalWordsChecked: number;
  errors: MisspelledWord[];
}

export class SpellingReport {
  public readonly language: string;
  public readonly totalWordsChecked: number;
  public readonly misspelledCount: number;
  public readonly errors: readonly MisspelledWord[];

  constructor(props: SpellingReportProps) {
    this.language = props.language;
    this.totalWordsChecked = props.totalWordsChecked;
    this.errors = Object.freeze([...props.errors]);
    this.misspelledCount = this.errors.length;
  }

  public toJSON() {
    return {
      language: this.language,
      totalWordsChecked: this.totalWordsChecked,
      misspelledCount: this.misspelledCount,
      errors: this.errors.map((e) => e.toJSON()),
    };
  }
}

export class LatexProseTokenizer {
  private static readonly TECHNICAL_ARG_COMMANDS = [
    'cite',
    'citep',
    'citet',
    'citealp',
    'citealt',
    'citeauthor',
    'citeyear',
    'newcite',
    'shortcite',
    'parencite',
    'textcite',
    'footcite',
    'smartcite',
    'autocite',
    'nocite',
    'ref',
    'pageref',
    'eqref',
    'autoref',
    'nameref',
    'cref',
    'Cref',
    'label',
    'input',
    'include',
    'subfile',
    'usepackage',
    'documentclass',
    'bibliographystyle',
    'bibliography',
    'addbibresource',
    'includegraphics',
    'url',
    'path',
    'texttt',
    'ac',
    'Ac',
    'acf',
    'acs',
    'acl',
    'acp',
    'Acp',
    'newcommand',
    'renewcommand',
    'DeclareMathOperator',
    'definecolor',
    'color',
  ];

  public tokenize(text: string): WordTokenVo[] {
    if (!text || text.trim() === '') return [];

    const lines = text.split(/\r?\n/);
    const tokens: WordTokenVo[] = [];

    let inVerbatimOrMathEnv = false;
    let ifFalseDepth = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const originalLine = lines[lineIdx];
      const lineNum = lineIdx + 1;

      const uncommentedLine = originalLine.split(/(?<!\\)%/)[0];
      if (/\\iffalse\b/.test(uncommentedLine)) {
        ifFalseDepth++;
      }
      if (ifFalseDepth > 0) {
        if (/\\fi\b/.test(uncommentedLine)) {
          ifFalseDepth = Math.max(0, ifFalseDepth - 1);
        }
        continue;
      }

      if (
        /\\begin\{(equation|align|alignat|gather|verbatim|lstlisting|minted|multline|flalign|tikzpicture)\*?\}/i.test(
          uncommentedLine,
        )
      ) {
        inVerbatimOrMathEnv = true;
      }

      if (inVerbatimOrMathEnv) {
        if (
          /\\end\{(equation|align|alignat|gather|verbatim|lstlisting|minted|multline|flalign|tikzpicture)\*?\}/i.test(
            uncommentedLine,
          )
        ) {
          inVerbatimOrMathEnv = false;
        }
        continue;
      }

      const maskedLine = this.maskLatexLine(originalLine);
      const wordRegex = /[\p{L}]+(?:['’][\p{L}]+)*/gu;
      let match: RegExpExecArray | null;

      while ((match = wordRegex.exec(maskedLine)) !== null) {
        const rawWord = match[0];
        if (rawWord.length === 1 && !/^[aiAIyYởỞýÝeEôÔ]$/u.test(rawWord)) {
          continue;
        }

        const col = match.index + 1;
        tokens.push(
          new WordTokenVo({
            word: rawWord,
            line: lineNum,
            col,
            length: rawWord.length,
          }),
        );
      }
    }

    return tokens;
  }

  private maskLatexLine(line: string): string {
    let result = line;

    for (let i = 0; i < result.length; i++) {
      if (result[i] === '%') {
        let backslashes = 0;
        let k = i - 1;
        while (k >= 0 && result[k] === '\\') {
          backslashes++;
          k--;
        }
        if (backslashes % 2 === 0) {
          result = result.slice(0, i) + ' '.repeat(result.length - i);
          break;
        }
      }
    }

    result = result.replace(/\\verb\*?([^a-zA-Z\s])([\s\S]*?)\1/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(/\$\$[\s\S]*?\$\$/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\\[[\s\S]*?\\\]/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\$(?:\\\$|[^$\n])+\$/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(/\\\([^)\n]+\\\)/g, (m) => ' '.repeat(m.length));

    for (const cmd of LatexProseTokenizer.TECHNICAL_ARG_COMMANDS) {
      const pattern = new RegExp(
        `\\\\${cmd}\\*?(?:\\[[^\\]]*\\])*\\{[^\\}]*\\}`,
        'g',
      );
      result = result.replace(pattern, (m) => ' '.repeat(m.length));
    }

    result = result.replace(
      /\\(begin|end)\{[^}]+\}(?:\[[^\]]*\])?(?:\{[^}]*\})*/g,
      (m) => ' '.repeat(m.length),
    );
    result = result.replace(/\\href\{[^}]+\}/g, (m) => ' '.repeat(m.length));
    result = result.replace(/https?:\/\/[^\s{}]+/g, (m) =>
      ' '.repeat(m.length),
    );
    result = result.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (m) => ' '.repeat(m.length),
    );
    result = result.replace(/\\[a-zA-Z]+\*?/g, (m) => ' '.repeat(m.length));
    result = result.replace(/\\[&%$#_{}~^]/g, (m) => ' '.repeat(m.length));

    return result;
  }
}

export class AcademicSpellEngine {
  private readonly englishDictionary: Set<string>;
  private readonly vietnameseDictionary: Set<string>;
  private readonly frenchDictionary: Set<string>;
  private readonly germanDictionary: Set<string>;
  private readonly spanishDictionary: Set<string>;
  private readonly lengthBuckets = new Map<
    Set<string>,
    Map<number, string[]>
  >();
  private readonly tokenizer: LatexProseTokenizer;

  constructor(tokenizer?: LatexProseTokenizer) {
    this.englishDictionary = new Set<string>();
    this.vietnameseDictionary = new Set<string>();
    this.frenchDictionary = new Set<string>();
    this.germanDictionary = new Set<string>();
    this.spanishDictionary = new Set<string>();
    this.tokenizer = tokenizer ?? new LatexProseTokenizer();
    this.seedDictionaries();
  }

  public static validateCustomWord(raw: string): string {
    const trimmed = (raw ?? '').trim();
    if (trimmed.length < 2) {
      throw new InvalidWordException(
        raw,
        'Learned word must be at least 2 characters long.',
      );
    }
    if (trimmed.length > 64) {
      throw new InvalidWordException(
        raw,
        'Learned word cannot exceed 64 characters.',
      );
    }
    if (/\s/.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word must be a single token without whitespace.',
      );
    }
    if (!/^[\p{L}\p{M}'’-]+$/u.test(trimmed)) {
      throw new InvalidWordException(
        raw,
        'Learned word may only contain letters, hyphens, or apostrophes.',
      );
    }
    return trimmed.toLowerCase();
  }

  public checkText(
    rawText: string,
    language?: string,
    customWords: Iterable<string> = [],
    maxSuggestions = 5,
    tokenizerOverride?: LatexProseTokenizer,
  ): SpellingReport {
    const langVo = LanguageCodeVo.create(language);

    if (!rawText || !rawText.trim()) {
      return new SpellingReport({
        language: langVo.code,
        totalWordsChecked: 0,
        errors: [],
      });
    }

    const activeTokenizer = tokenizerOverride ?? this.tokenizer;
    const tokens = activeTokenizer.tokenize(rawText);
    const customSet = new Set<string>();
    for (const w of customWords) {
      customSet.add(w.toLowerCase());
    }

    const errors: MisspelledWord[] = [];
    const suggestionsCache = new Map<string, string[]>();

    for (const token of tokens) {
      const lower = token.normalized;
      if (customSet.has(lower)) {
        continue;
      }
      if (this.isCorrect(token.word, langVo) || this.isCorrect(lower, langVo)) {
        continue;
      }

      let suggestions = suggestionsCache.get(lower);
      if (!suggestions) {
        suggestions = this.getSuggestions(
          token.word,
          langVo,
          maxSuggestions,
        );
        suggestionsCache.set(lower, suggestions);
      }

      errors.push(
        new MisspelledWord({
          word: token.word,
          line: token.line,
          col: token.col,
          length: token.length,
          suggestions,
        }),
      );
    }

    return new SpellingReport({
      language: langVo.code,
      totalWordsChecked: tokens.length,
      errors,
    });
  }

  private getDictionaryForLanguage(language: LanguageCodeVo): Set<string> {
    switch (language.baseLanguage) {
      case 'vi':
        return this.vietnameseDictionary;
      case 'fr':
        return this.frenchDictionary;
      case 'de':
        return this.germanDictionary;
      case 'es':
        return this.spanishDictionary;
      default:
        return this.englishDictionary;
    }
  }

  public isCorrect(word: string, language: LanguageCodeVo): boolean {
    const clean = word.toLowerCase().trim().normalize('NFC');
    if (!clean) return true;

    if (/^\d+$/.test(clean) || clean.length === 1) return true;

    const dict = this.getDictionaryForLanguage(language);
    if (dict.has(clean)) return true;

    if (clean.includes('-') || clean.includes("'") || clean.includes('’')) {
      const parts = clean.split(/[-'’]/);
      if (
        parts.length > 1 &&
        parts.every((p) => !p || this.isCorrect(p, language))
      ) {
        return true;
      }
    }

    const baseLang = language.baseLanguage;
    if (baseLang === 'en') {
      const stems = this.getMorphologicalStems(clean);
      for (const stem of stems) {
        if (dict.has(stem)) {
          return true;
        }
      }
    } else if (baseLang === 'fr' || baseLang === 'de' || baseLang === 'es') {
      const stems = this.getRomanceGermanicStems(clean, baseLang);
      for (const stem of stems) {
        if (dict.has(stem)) {
          return true;
        }
      }
    }

    return false;
  }

  public getSuggestions(
    word: string,
    language: LanguageCodeVo,
    maxSuggestions = 5,
  ): string[] {
    const clean = word.toLowerCase().trim().normalize('NFC');
    if (!clean) return [];

    if (this.isCorrect(word, language)) {
      return [];
    }

    const isCapitalized = /^[A-ZÀ-ÖØ-Þ]/.test(word);
    const isAllUpper = /^[A-ZÀ-ÖØ-Þ]+$/.test(word) && word.length > 1;

    interface Candidate {
      word: string;
      dist: number;
    }

    const candidates: Candidate[] = [];
    const dict = this.getDictionaryForLanguage(language);
    const buckets = this.lengthBuckets.get(dict);

    if (buckets) {
      const minLen = Math.max(1, clean.length - 2);
      const maxLen = clean.length + 2;
      for (let len = minLen; len <= maxLen; len++) {
        const bucket = buckets.get(len);
        if (!bucket) continue;
        for (const dictWord of bucket) {
          const dist = this.levenshteinDamerau(clean, dictWord);
          if (dist <= 2) {
            candidates.push({ word: dictWord, dist });
          }
        }
      }
    } else {
      for (const dictWord of dict) {
        if (Math.abs(dictWord.length - clean.length) > 2) {
          continue;
        }

        const dist = this.levenshteinDamerau(clean, dictWord);
        if (dist <= 2) {
          candidates.push({ word: dictWord, dist });
        }
      }
    }

    candidates.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      const lenDiffA = Math.abs(a.word.length - clean.length);
      const lenDiffB = Math.abs(b.word.length - clean.length);
      if (lenDiffA !== lenDiffB) return lenDiffA - lenDiffB;
      return a.word.localeCompare(b.word);
    });

    return candidates.slice(0, maxSuggestions).map((c) => {
      if (isAllUpper) return c.word.toUpperCase();
      if (isCapitalized)
        return c.word.charAt(0).toUpperCase() + c.word.slice(1);
      return c.word;
    });
  }

  public getSupportedLanguages(): string[] {
    return [
      'en',
      'en-US',
      'en-GB',
      'en-CA',
      'vi',
      'vi-VN',
      'fr',
      'fr-FR',
      'de',
      'de-DE',
      'es',
      'es-ES',
    ];
  }

  private getRomanceGermanicStems(word: string, baseLang: string): string[] {
    const stems: string[] = [];
    if (word.length <= 3) return stems;

    if (baseLang === 'fr') {
      for (const suffix of [
        'ements',
        'ement',
        'ations',
        'ation',
        'iques',
        'ique',
        'ables',
        'able',
        'euses',
        'euse',
        'eurs',
        'eur',
        'aux',
        'ent',
        'ées',
        'és',
        'ée',
        'er',
        'ir',
        'es',
        's',
        'e',
      ]) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
          stems.push(word.slice(0, -suffix.length));
          stems.push(word.slice(0, -suffix.length) + 'e');
          stems.push(word.slice(0, -suffix.length) + 'er');
        }
      }
    } else if (baseLang === 'de') {
      for (const suffix of [
        'ungen',
        'ung',
        'keiten',
        'keit',
        'heiten',
        'heit',
        'ische',
        'ischen',
        'ischer',
        'isches',
        'isch',
        'ieren',
        'iert',
        'ern',
        'eln',
        'en',
        'er',
        'es',
        'em',
        'st',
        'te',
        'ten',
        'e',
        's',
        'n',
      ]) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
          stems.push(word.slice(0, -suffix.length));
          stems.push(word.slice(0, -suffix.length) + 'en');
        }
      }
    } else if (baseLang === 'es') {
      for (const suffix of [
        'aciones',
        'ación',
        'acion',
        'amientos',
        'amiento',
        'mente',
        'idades',
        'idad',
        'ables',
        'able',
        'ibles',
        'ible',
        'ando',
        'iendo',
        'ados',
        'adas',
        'ado',
        'ada',
        'idos',
        'idas',
        'ido',
        'ida',
        'aron',
        'ieron',
        'aban',
        'ían',
        'es',
        'as',
        'os',
        'an',
        'en',
        'ar',
        'er',
        'ir',
        's',
        'a',
        'o',
      ]) {
        if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
          stems.push(word.slice(0, -suffix.length));
          stems.push(word.slice(0, -suffix.length) + 'o');
          stems.push(word.slice(0, -suffix.length) + 'a');
          stems.push(word.slice(0, -suffix.length) + 'ar');
          stems.push(word.slice(0, -suffix.length) + 'er');
        }
      }
    }

    return stems;
  }

  private getMorphologicalStems(word: string): string[] {
    const stems: string[] = [];

    if (word.endsWith('ies') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('es') && word.length > 3) {
      stems.push(word.slice(0, -2));
      stems.push(word.slice(0, -1));
    } else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
      stems.push(word.slice(0, -1));
    }

    if (word.endsWith('ied') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('ed') && word.length > 3) {
      stems.push(word.slice(0, -2));
      stems.push(word.slice(0, -1));
      if (
        word.length > 5 &&
        word.charAt(word.length - 3) === word.charAt(word.length - 4)
      ) {
        stems.push(word.slice(0, -3));
      }
    }

    if (word.endsWith('ing') && word.length > 4) {
      stems.push(word.slice(0, -3));
      stems.push(word.slice(0, -3) + 'e');
      if (
        word.length > 5 &&
        word.charAt(word.length - 4) === word.charAt(word.length - 5)
      ) {
        stems.push(word.slice(0, -4));
      }
    }

    if (word.endsWith('ally') && word.length > 5) {
      stems.push(word.slice(0, -4));
      stems.push(word.slice(0, -2));
    } else if (word.endsWith('ily') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('ly') && word.length > 4) {
      stems.push(word.slice(0, -2));
    }

    if (word.endsWith('able') && word.length > 5) {
      stems.push(word.slice(0, -4));
      stems.push(word.slice(0, -4) + 'e');
    }
    if (word.endsWith('ment') && word.length > 5) {
      stems.push(word.slice(0, -4));
    }
    if (word.endsWith('ness') && word.length > 5) {
      stems.push(word.slice(0, -4));
    }
    if (word.endsWith('ity') && word.length > 5) {
      stems.push(word.slice(0, -3));
      stems.push(word.slice(0, -3) + 'e');
    }

    return stems;
  }

  private levenshteinDamerau(source: string, target: string): number {
    const sLen = source.length;
    const tLen = target.length;

    if (sLen === 0) return tLen;
    if (tLen === 0) return sLen;

    const d: number[][] = Array.from({ length: sLen + 1 }, () =>
      new Array(tLen + 1).fill(0),
    );

    for (let i = 0; i <= sLen; i++) d[i][0] = i;
    for (let j = 0; j <= tLen; j++) d[0][j] = j;

    for (let i = 1; i <= sLen; i++) {
      for (let j = 1; j <= tLen; j++) {
        const cost = source[i - 1] === target[j - 1] ? 0 : 1;

        d[i][j] = Math.min(
          d[i - 1][j] + 1,
          d[i][j - 1] + 1,
          d[i - 1][j - 1] + cost,
        );

        if (
          i > 1 &&
          j > 1 &&
          source[i - 1] === target[j - 2] &&
          source[i - 2] === target[j - 1]
        ) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }

    return d[sLen][tLen];
  }

  private seedDictionaries(): void {
    for (const w of ACADEMIC_SHARED_WORDS) {
      const lower = w.toLowerCase();
      this.englishDictionary.add(lower);
      this.vietnameseDictionary.add(lower);
      this.frenchDictionary.add(lower);
      this.germanDictionary.add(lower);
      this.spanishDictionary.add(lower);
    }

    for (const w of ENGLISH_COMMON_WORDS) {
      this.englishDictionary.add(w.toLowerCase());
    }

    for (const w of VIETNAMESE_COMMON_WORDS) {
      this.vietnameseDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of FRENCH_ACADEMIC_WORDS) {
      this.frenchDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of GERMAN_ACADEMIC_WORDS) {
      this.germanDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const w of SPANISH_ACADEMIC_WORDS) {
      this.spanishDictionary.add(w.toLowerCase().normalize('NFC'));
    }

    for (const dict of [
      this.englishDictionary,
      this.vietnameseDictionary,
      this.frenchDictionary,
      this.germanDictionary,
      this.spanishDictionary,
    ]) {
      const bucketMap = new Map<number, string[]>();
      for (const word of dict) {
        const len = word.length;
        let list = bucketMap.get(len);
        if (!list) {
          list = [];
          bucketMap.set(len, list);
        }
        list.push(word);
      }
      this.lengthBuckets.set(dict, bucketMap);
    }
  }
}
