/**
 * spelling/core/adapters/engine/academic-spell-engine.adapter.ts
 * Adapter implementing ISpellEnginePort.
 * High-performance spell checker with academic vocabulary & Levenshtein-Damerau
 * distance suggestion ranking, augmented with morphological inflection analysis.
 */

import { Injectable } from '@nestjs/common';
import { ISpellEnginePort } from '../../ports/spell-engine.port';
import { LanguageCodeVo } from '../../domain/value-objects/language-code.vo';

@Injectable()
export class AcademicSpellEngineAdapter implements ISpellEnginePort {
  private readonly englishDictionary: Set<string>;
  private readonly vietnameseDictionary: Set<string>;

  constructor() {
    this.englishDictionary = new Set<string>();
    this.vietnameseDictionary = new Set<string>();
    this.seedDictionaries();
  }

  public isCorrect(word: string, language: LanguageCodeVo): boolean {
    const clean = word.toLowerCase().trim();
    if (!clean) return true;

    // Numbers, hex, formulas, single letters (variables like a, i, x, y, k, n)
    if (/^\d+$/.test(clean) || clean.length === 1) return true;

    const dict =
      language.baseLanguage === 'vi'
        ? this.vietnameseDictionary
        : this.englishDictionary;
    if (dict.has(clean)) return true;

    // For English, test morphological inflections (plurals, past, gerund, adverbs)
    if (language.baseLanguage !== 'vi') {
      const stems = this.getMorphologicalStems(clean);
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
    const clean = word.toLowerCase().trim();
    if (!clean) return [];

    if (this.isCorrect(word, language)) {
      return [];
    }

    const isCapitalized = /^[A-Z]/.test(word);
    const isAllUpper = /^[A-Z]+$/.test(word) && word.length > 1;

    interface Candidate {
      word: string;
      dist: number;
    }

    const candidates: Candidate[] = [];
    const dict =
      language.baseLanguage === 'vi'
        ? this.vietnameseDictionary
        : this.englishDictionary;

    // Filter by length heuristic: candidates with abs(len - clean.len) <= 2
    for (const dictWord of dict) {
      if (Math.abs(dictWord.length - clean.length) > 2) {
        continue;
      }

      const dist = this.levenshteinDamerau(clean, dictWord);
      if (dist <= 2) {
        candidates.push({ word: dictWord, dist });
      }
    }

    // Sort by edit distance first, then length similarity, then alphabetical
    candidates.sort((a, b) => {
      if (a.dist !== b.dist) return a.dist - b.dist;
      const lenDiffA = Math.abs(a.word.length - clean.length);
      const lenDiffB = Math.abs(b.word.length - clean.length);
      if (lenDiffA !== lenDiffB) return lenDiffA - lenDiffB;
      return a.word.localeCompare(b.word);
    });

    const results = candidates.slice(0, maxSuggestions).map((c) => {
      if (isAllUpper) return c.word.toUpperCase();
      if (isCapitalized)
        return c.word.charAt(0).toUpperCase() + c.word.slice(1);
      return c.word;
    });

    return results;
  }

  public getSupportedLanguages(): string[] {
    return ['en', 'en-US', 'en-GB', 'en-CA', 'vi', 'vi-VN', 'fr', 'de', 'es'];
  }

  /**
   * Generates morphological stems for standard English inflections:
   * plurals (-s, -es, -ies), past (-ed, -ied), gerunds (-ing), adverbs (-ly), etc.
   */
  private getMorphologicalStems(word: string): string[] {
    const stems: string[] = [];

    // Plurals / 3rd-person singular
    if (word.endsWith('ies') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('es') && word.length > 3) {
      stems.push(word.slice(0, -2));
      stems.push(word.slice(0, -1));
    } else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) {
      stems.push(word.slice(0, -1));
    }

    // Past / passive participle
    if (word.endsWith('ied') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('ed') && word.length > 3) {
      stems.push(word.slice(0, -2));
      stems.push(word.slice(0, -1));
      // Double consonant e.g. stopped -> stop
      if (
        word.length > 5 &&
        word.charAt(word.length - 3) === word.charAt(word.length - 4)
      ) {
        stems.push(word.slice(0, -3));
      }
    }

    // Present participle / gerund
    if (word.endsWith('ing') && word.length > 4) {
      stems.push(word.slice(0, -3));
      stems.push(word.slice(0, -3) + 'e');
      // Double consonant e.g. running -> run
      if (
        word.length > 5 &&
        word.charAt(word.length - 4) === word.charAt(word.length - 5)
      ) {
        stems.push(word.slice(0, -4));
      }
    }

    // Adverbs (-ly, -ally)
    if (word.endsWith('ally') && word.length > 5) {
      stems.push(word.slice(0, -4));
      stems.push(word.slice(0, -2));
    } else if (word.endsWith('ily') && word.length > 4) {
      stems.push(word.slice(0, -3) + 'y');
    } else if (word.endsWith('ly') && word.length > 4) {
      stems.push(word.slice(0, -2));
    }

    // Suffixes: -able, -ible, -ment, -ness, -ity, -tion
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

  /**
   * Calculates Levenshtein-Damerau distance (insertions, deletions, substitutions & adjacent transpositions).
   */
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
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + cost, // substitution
        );

        // Transposition
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

  /**
   * Seeds dictionaries with high-frequency academic, LaTeX, scientific and standard vocabulary.
   */
  private seedDictionaries(): void {
    const academicWords = [
      // Core LaTeX & Publishing
      'latex',
      'overleaf',
      'tex',
      'bibtex',
      'synctex',
      'manuscript',
      'manuscripts',
      'document',
      'section',
      'abstract',
      'introduction',
      'conclusion',
      'acknowledgements',
      'references',
      'bibliography',
      'appendix',
      'equation',
      'figure',
      'table',
      'caption',
      'footnote',
      'citation',
      'citations',
      'author',
      'authors',
      'journal',
      'conference',
      'proceedings',
      'volume',
      'issue',
      'pages',
      'publisher',
      'editor',
      'preface',
      'chapter',
      'subchapter',
      'thesis',
      'dissertation',
      'proposal',
      'report',
      'review',
      'revision',
      'draft',
      'peer-review',
      'galley',
      'typeset',
      'typesetting',
      'preprint',
      'postprint',

      // Computer Science & Software Engineering
      'algorithm',
      'algorithms',
      'algorithmic',
      'architecture',
      'architectures',
      'artificial',
      'intelligence',
      'machine',
      'learning',
      'deep',
      'neural',
      'network',
      'networks',
      'transformer',
      'transformers',
      'attention',
      'attention-mechanism',
      'backpropagation',
      'gradient',
      'descent',
      'stochastic',
      'optimization',
      'optimizer',
      'regularization',
      'overfitting',
      'underfitting',
      'hyperparameter',
      'hyperparameters',
      'tensor',
      'tensors',
      'matrix',
      'matrices',
      'vector',
      'vectors',
      'dimension',
      'dimensional',
      'dimensionality',
      'feature',
      'features',
      'representation',
      'representations',
      'embedding',
      'embeddings',
      'convolutional',
      'recurrent',
      'encoder',
      'decoder',
      'supervised',
      'unsupervised',
      'reinforcement',
      'dataset',
      'datasets',
      'benchmark',
      'benchmarks',
      'baseline',
      'baselines',
      'accuracy',
      'precision',
      'recall',
      'f1-score',
      'loss',
      'convergence',
      'epoch',
      'epochs',
      'batch',
      'batches',
      'mini-batch',
      'iteration',
      'iterations',
      'inference',
      'training',
      'validation',
      'testing',
      'cross-validation',
      'generalization',
      'classification',
      'regression',
      'clustering',
      'segmentation',
      'detection',
      'generative',
      'adversarial',
      'diffusion',
      'database',
      'databases',
      'compiler',
      'compilers',
      'parser',
      'parsers',
      'tokenizer',
      'tokenizers',
      'interpreter',
      'runtime',
      'framework',
      'library',
      'module',
      'package',
      'server',
      'client',
      'frontend',
      'backend',
      'websocket',
      'socket',
      'cache',
      'buffer',
      'concurrency',
      'parallel',
      'distributed',
      'thread',
      'process',
      'mutex',
      'lock',

      // Mathematics & Statistics
      'theorem',
      'theorems',
      'lemma',
      'lemmas',
      'corollary',
      'corollaries',
      'proposition',
      'proof',
      'proofs',
      'conjecture',
      'axiom',
      'axioms',
      'definition',
      'definitions',
      'probability',
      'probabilistic',
      'statistic',
      'statistics',
      'statistical',
      'distribution',
      'distributions',
      'gaussian',
      'normal',
      'binomial',
      'poisson',
      'variance',
      'covariance',
      'expectation',
      'mean',
      'median',
      'mode',
      'standard',
      'deviation',
      'correlation',
      'hypothesis',
      'hypotheses',
      'null',
      'alternative',
      'significance',
      'p-value',
      'eigenvalue',
      'eigenvalues',
      'eigenvector',
      'eigenvectors',
      'orthogonal',
      'orthonormal',
      'linear',
      'nonlinear',
      'convex',
      'nonconvex',
      'concave',
      'differential',
      'derivative',
      'integral',
      'integrals',
      'asymptotic',
      'complexity',
      'polynomial',
      'exponential',
      'logarithmic',
      'discrete',
      'continuous',
      'deterministic',
      'entropy',
      'stochasticity',

      // Natural Sciences & Engineering
      'physics',
      'physical',
      'chemistry',
      'chemical',
      'biology',
      'biological',
      'quantum',
      'mechanics',
      'thermodynamics',
      'optics',
      'particle',
      'atom',
      'atomic',
      'molecule',
      'molecular',
      'electron',
      'proton',
      'neutron',
      'photon',
      'energy',
      'momentum',
      'velocity',
      'acceleration',
      'force',
      'gravity',
      'electromagnetic',
      'radiation',
      'frequency',
      'wavelength',
      'amplitude',
      'spectrum',
      'resonance',
      'temperature',
      'pressure',
      'density',
      'viscosity',
      'velocity',
      'equilibrium',
      'kinetics',
      'catalyst',
      'reaction',
      'synthesis',
      'compound',
      'element',
      'polymer',
      'nanotechnology',
      'sensor',

      // Core Grammar & Common Verbs / Function Words
      'the',
      'be',
      'to',
      'of',
      'and',
      'a',
      'in',
      'that',
      'have',
      'i',
      'it',
      'for',
      'not',
      'on',
      'with',
      'he',
      'as',
      'you',
      'do',
      'at',
      'this',
      'but',
      'his',
      'by',
      'from',
      'they',
      'we',
      'say',
      'her',
      'she',
      'or',
      'an',
      'will',
      'my',
      'one',
      'all',
      'would',
      'there',
      'their',
      'what',
      'so',
      'up',
      'out',
      'if',
      'about',
      'who',
      'get',
      'which',
      'go',
      'me',
      'when',
      'make',
      'can',
      'like',
      'time',
      'no',
      'just',
      'him',
      'know',
      'take',
      'people',
      'into',
      'year',
      'your',
      'good',
      'some',
      'could',
      'them',
      'see',
      'other',
      'than',
      'then',
      'now',
      'look',
      'only',
      'come',
      'its',
      'over',
      'think',
      'also',
      'back',
      'after',
      'use',
      'two',
      'how',
      'our',
      'work',
      'first',
      'well',
      'way',
      'even',
      'new',
      'want',
      'because',
      'any',
      'these',
      'give',
      'day',
      'most',
      'us',
      'great',
      'sample',
      'paper',
      'received',
      'shown',
      'shows',
      'present',
      'presents',
      'presented',
      'proposed',
      'proposes',
      'investigate',
      'investigates',
      'investigated',
      'demonstrate',
      'demonstrates',
      'demonstrated',
      'evaluate',
      'evaluates',
      'evaluated',
      'compare',
      'compares',
      'compared',
      'comparison',
      'comparative',
      'achieve',
      'achieves',
      'achieved',
      'outperform',
      'outperforms',
      'outperformed',
      'novel',
      'superior',
      'effective',
      'efficient',
      'efficiency',
      'robust',
      'robustness',
      'scalable',
      'scalability',
      'method',
      'methods',
      'methodology',
      'approach',
      'approaches',
      'technique',
      'techniques',
      'system',
      'systems',
      'model',
      'models',
      'modeling',
      'experimental',
      'experiments',
      'results',
      'discussion',
      'analysis',
      'empirical',
      'theoretical',
      'findings',
      'future',
      'perspective',
      'perspectives',
      'limitation',
      'limitations',
      'context',
      'domain',
      'application',
      'applications',
      'implement',
      'implements',
      'implemented',
      'implementation',
      'performance',
      'metric',
      'metrics',
      'score',
      'scores',
      'observation',
      'observations',
      'derive',
      'derives',
      'derived',
      'formulate',
      'formulates',
      'formulated',
      'formulation',
      'assume',
      'assumes',
      'assumed',
      'assumption',
      'assumptions',
      'denote',
      'denotes',
      'denoted',
      'let',
      'suppose',
      'given',
      'consider',
      'considering',
      'considered',
      'define',
      'defines',
      'defined',
      'indicate',
      'indicates',
      'indicated',
      'suggest',
      'suggests',
      'suggested',
      'reveal',
      'reveals',
      'revealed',
      'confirm',
      'confirms',
      'confirmed',
      'validate',
      'validates',
      'validated',
      'verify',
      'verifies',
      'verified',
      'exhibit',
      'exhibits',
      'exhibited',
      'illustrate',
      'illustrates',
      'illustrated',
      'depict',
      'depicts',
      'depicted',
      'summarize',
      'summarizes',
      'summarized',
      'outline',
      'outlines',
      'outlined',
      'detail',
      'details',
      'detailed',
      'specifically',
      'furthermore',
      'moreover',
      'however',
      'nevertheless',
      'consequently',
      'therefore',
      'thus',
      'hence',
      'accordingly',
      'respectively',
      'similarly',
      'conversely',
      'importantly',
      'notably',
      'crucially',
      'substantially',
      'significantly',
      'marginally',
      'approximately',
      'roughly',
      'primarily',
      'predominantly',
      'essentially',
      'fundamentally',

      // General Life, Everyday & Academic Institution Vocabulary
      'university',
      'universities',
      'institute',
      'institutes',
      'laboratory',
      'laboratories',
      'department',
      'departments',
      'faculty',
      'student',
      'students',
      'professor',
      'professors',
      'researcher',
      'researchers',
      'scholar',
      'scholars',
      'fellow',
      'fellowship',
      'grant',
      'grants',
      'funding',
      'collaborator',
      'collaborators',
      'collaboration',
      'project',
      'projects',
      'computer',
      'computers',
      'screen',
      'keyboard',
      'device',
      'devices',
      'hardware',
      'software',
      'network',
      'internet',
      'web',
      'page',
      'site',
      'platform',
      'service',
      'storage',
      'cloud',
      'world',
      'country',
      'city',
      'state',
      'government',
      'society',
      'social',
      'human',
      'culture',
      'history',
      'historical',
      'language',
      'linguistic',
      'education',
      'educational',
      'school',
      'study',
      'studies',
      'learning',
      'teaching',
      'knowledge',
      'skill',
      'ability',
      'practice',
      'theory',
      'concept',
      'idea',
      'thought',
      'view',
      'opinion',
      'argument',
      'claim',
      'statement',
      'question',
      'answer',
      'problem',
      'solution',
      'issue',
      'topic',
      'subject',
      'field',
      'area',
      'scope',
      'range',
      'scale',
      'size',
      'amount',
      'degree',
      'rate',
      'ratio',
      'percentage',
      'test',
      'tests',
      'tested',
      'testing',
      'line',
      'lines',
      'second',
      'third',
      'clean',
      'clear',
      'mistake',
      'mistakes',
      'error',
      'errors',
      'correct',
      'correction',
      'check',
      'checks',
      'checked',
      'checking',
      'spelling',
      'spell',
      'word',
      'words',
      'string',
      'strings',
      'text',
      'texts',
      'file',
      'files',
      'folder',
      'folders',
      'user',
      'users',
      'read',
      'write',
      'update',
      'delete',
      'create',
      'save',
      'load',
      'send',
      'receive',
      'contains',
      'contained',
      'containing',
      'include',
      'included',
      'includes',
      'including',
      'exclude',
      'show',
      'case',
      'data',
      'datum',
      'info',
      'information',
      'point',
      'part',
      'step',
      'stage',
      'level',
      'value',
      'set',
      'map',
      'list',
      'array',
      'number',
      'zero',
      'three',
      'four',
      'five',
      'six',
      'seven',
      'eight',
      'nine',
      'ten',
      'hundred',
      'thousand',
      'million',
      'billion',
      'simple',
      'complex',
      'small',
      'large',
      'high',
      'low',
      'fast',
      'slow',
      'better',
      'best',
      'bad',
      'worse',
      'worst',
      'true',
      'false',
      'yes',
      'null',
      'none',
      'every',
      'each',
      'both',
      'either',
      'neither',
      'same',
      'different',
      'similar',
      'equal',
      'equivalent',
      'exact',
      'approximate',
      'rough',
      'fine',
      'main',
      'major',
      'minor',
      'key',
      'core',
      'root',
      'base',
      'node',
      'tree',
      'graph',
      'path',
      'route',
      'source',
      'target',
      'input',
      'output',
      'param',
      'parameter',
      'argument',
      'function',
      'class',
      'type',
      'token',
      'symbol',
      'character',
      'letter',
      'quote',
      'comment',
      'block',
      'code',
      'build',
      'run',
      'stop',
      'start',
      'end',
      'begin',
      'finish',
      'done',
      'fail',
      'pass',
      'success',
      'successful',
      'warn',
      'warning',
      'debug',
      'trace',
      'log',
      'logger',
      'hello',
      'world',
    ];

    for (const w of academicWords) {
      this.englishDictionary.add(w.toLowerCase());
    }

    const vietnameseWords = [
      'thuật',
      'toán',
      'mô',
      'hình',
      'học',
      'máy',
      'sâu',
      'trí',
      'tuệ',
      'nhân',
      'tạo',
      'bài',
      'báo',
      'nghiên',
      'cứu',
      'khoa',
      'học',
      'kết',
      'quả',
      'thực',
      'nghiệm',
      'phân',
      'tích',
      'đánh',
      'giá',
      'phương',
      'pháp',
      'hệ',
      'thống',
      'dữ',
      'liệu',
      'độ',
      'chính',
      'xác',
      'mạng',
      'nơ-ron',
      'tối',
      'ưu',
      'hóa',
      'công',
      'thức',
      'luận',
      'văn',
      'tóm',
      'tắt',
      'mở',
      'đầu',
      'kết',
      'luận',
      'tài',
      'liệu',
      'tham',
      'khảo',
      'trích',
      'dẫn',
      'hình',
      'ảnh',
      'bảng',
      'biểu',
      'đồ',
      'chương',
      'mục',
      'giả',
      'thuyết',
      'thông',
      'tin',
      'công',
      'nghệ',
      'phần',
      'mềm',
      'chương',
      'trình',
    ];

    for (const w of vietnameseWords) {
      this.vietnameseDictionary.add(w.toLowerCase());
    }
  }
}
