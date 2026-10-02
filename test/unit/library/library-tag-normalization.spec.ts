import {
  cleanSingleTag,
  normalizeAcademicTags,
  normalizeTags,
  toTitleCaseWithAcronyms,
  stripLatexMarkup,
  stripTagPrefixes,
} from '@/modules/library/shared-kernel/utils/tag.utils';
import { ItemsMapper } from '@/modules/library/catalog/core/adapters/items.mapper';
import { toItemData } from '@/modules/library/ingestion/core/adapters/commit.stage';

describe('Library Academic Tag Sanitizer & Normalizer', () => {
  describe('1. Scientific Acronyms & Casing Preservation', () => {
    it('should preserve standard scientific acronyms in uppercase', () => {
      expect(cleanSingleTag('ai')).toBe('AI');
      expect(cleanSingleTag('ml')).toBe('ML');
      expect(cleanSingleTag('nlp')).toBe('NLP');
      expect(cleanSingleTag('cnn')).toBe('CNN');
      expect(cleanSingleTag('llm')).toBe('LLM');
      expect(cleanSingleTag('covid-19')).toBe('COVID-19');
      expect(cleanSingleTag('lora')).toBe('LORA');
      expect(cleanSingleTag('gnn')).toBe('GNN');
      expect(cleanSingleTag('rag')).toBe('RAG');
    });

    it('should format terms into Title Case while keeping minor words lowercase', () => {
      expect(cleanSingleTag('machine learning')).toBe('Machine Learning');
      expect(cleanSingleTag('deep reinforcement learning')).toBe(
        'Deep Reinforcement Learning',
      );
      expect(cleanSingleTag('computer vision and pattern recognition')).toBe(
        'Computer Vision and Pattern Recognition',
      );
      expect(cleanSingleTag('viola-jones algorithm')).toBe(
        'Viola-Jones Algorithm',
      );
    });
  });

  describe('2. ArXiv Taxonomy Code Mapping', () => {
    it('should expand taxonomy codes to standard human-readable academic fields', () => {
      expect(cleanSingleTag('cs.ai')).toBe(
        'Computer Science - Artificial Intelligence',
      );
      expect(cleanSingleTag('cs.CL')).toBe(
        'Computer Science - Computation and Language',
      );
      expect(cleanSingleTag('stat.ML')).toBe('Statistics - Machine Learning');
      expect(cleanSingleTag('cs-cv')).toBe(
        'Computer Science - Computer Vision and Pattern Recognition',
      );
    });
  });

  describe('3. Compound Tag Splitting & Safe Slash Handling', () => {
    it('should split compound tags by comma, semicolon, bullet, pipe, or space-surrounded slashes', () => {
      const raw =
        'Machine Learning; Natural Language Processing, Computer Vision • Deep Learning | Robotics / Reinforcement Learning';
      const result = normalizeAcademicTags([raw]);
      expect(result).toEqual([
        'Machine Learning',
        'Natural Language Processing',
        'Computer Vision',
        'Deep Learning',
        'Robotics',
        'Reinforcement Learning',
      ]);
    });

    it('should preserve safe domain slashes without spaces (e.g. TCP/IP, Client/Server)', () => {
      const raw = 'TCP/IP; Client/Server architecture';
      const result = normalizeAcademicTags([raw]);
      expect(result).toEqual(['TCP/IP', 'Client/Server Architecture']);
    });
  });

  describe('4. LaTeX Markup Sanitization', () => {
    it('should strip LaTeX formatting commands, macros, braces, and escaped characters', () => {
      expect(stripLatexMarkup('{\\bf Deep Learning}')).toBe('Deep Learning');
      expect(stripLatexMarkup('\\textit{Reinforcement Learning}')).toBe(
        'Reinforcement Learning',
      );
      expect(stripLatexMarkup('{Artificial Intelligence}')).toBe(
        'Artificial Intelligence',
      );
      expect(stripLatexMarkup('Hardware \\& Software')).toBe(
        'Hardware & Software',
      );

      expect(cleanSingleTag('{\\bf Machine Learning}')).toBe(
        'Machine Learning',
      );
      expect(cleanSingleTag('\\textbf{Neural Networks}')).toBe(
        'Neural Networks',
      );
    });
  });

  describe('5. Strict Junk & Noise Filtering (No Junk Tags Allowed)', () => {
    it('should reject identifier metadata (DOI, PMID, ISBN, ISSN, URLs, arXiv IDs)', () => {
      expect(cleanSingleTag('doi: 10.1038/s41586-020-2649-2')).toBeNull();
      expect(cleanSingleTag('10.1145/3377325.3377496')).toBeNull();
      expect(cleanSingleTag('doi:10.1016/j.cell.2020.08.001')).toBeNull();
      expect(cleanSingleTag('https://doi.org/10.1038/xyz')).toBeNull();
      expect(cleanSingleTag('pmid: 12345678')).toBeNull();
      expect(cleanSingleTag('pmcid: PMC1234567')).toBeNull();
      expect(cleanSingleTag('isbn: 978-3-16-148410-0')).toBeNull();
      expect(cleanSingleTag('issn: 2049-3630')).toBeNull();
      expect(cleanSingleTag('arxiv: 2106.12345')).toBeNull();
      expect(cleanSingleTag('http://example.com/paper.pdf')).toBeNull();
      expect(cleanSingleTag('www.nature.com')).toBeNull();
    });

    it('should reject placeholder and noise words', () => {
      expect(cleanSingleTag('n/a')).toBeNull();
      expect(cleanSingleTag('N/A')).toBeNull();
      expect(cleanSingleTag('null')).toBeNull();
      expect(cleanSingleTag('undefined')).toBeNull();
      expect(cleanSingleTag('none')).toBeNull();
      expect(cleanSingleTag('unknown')).toBeNull();
      expect(cleanSingleTag('sample')).toBeNull();
      expect(cleanSingleTag('draft')).toBeNull();
      expect(cleanSingleTag('test')).toBeNull();
      expect(cleanSingleTag('etc.')).toBeNull();
      expect(cleanSingleTag('et al.')).toBeNull();
      expect(cleanSingleTag('downloaded')).toBeNull();
      expect(cleanSingleTag('downloaded from')).toBeNull();
      expect(cleanSingleTag('full text')).toBeNull();
      expect(cleanSingleTag('pdf')).toBeNull();
      expect(cleanSingleTag('abstract')).toBeNull();
      expect(cleanSingleTag('open access')).toBeNull();
      expect(cleanSingleTag('all rights reserved')).toBeNull();
      expect(cleanSingleTag('peer-reviewed')).toBeNull();
      expect(cleanSingleTag('original article')).toBeNull();
      expect(cleanSingleTag('springer')).toBeNull();
    });

    it('should reject pagination, volume, issue, and standalone Roman numerals', () => {
      expect(cleanSingleTag('pp. 12-15')).toBeNull();
      expect(cleanSingleTag('pages 10-20')).toBeNull();
      expect(cleanSingleTag('vol. 4')).toBeNull();
      expect(cleanSingleTag('no. 2')).toBeNull();
      expect(cleanSingleTag('issue 3')).toBeNull();
      expect(cleanSingleTag('Vol. 4, No. 2')).toBeNull();
      expect(cleanSingleTag('iv')).toBeNull();
      expect(cleanSingleTag('ix')).toBeNull();
      expect(cleanSingleTag('xii')).toBeNull();
    });

    it('should reject standalone years, year ranges, and calendar dates', () => {
      expect(cleanSingleTag('2021')).toBeNull();
      expect(cleanSingleTag('2020-2021')).toBeNull();
      expect(cleanSingleTag('2024-05-12')).toBeNull();
      expect(cleanSingleTag('12-05-2024')).toBeNull();
      expect(cleanSingleTag('May 2021')).toBeNull();
      expect(cleanSingleTag('January 2020')).toBeNull();
    });

    it('should reject pure punctuation and symbol strings', () => {
      expect(cleanSingleTag('...')).toBeNull();
      expect(cleanSingleTag('•')).toBeNull();
      expect(cleanSingleTag('---')).toBeNull();
      expect(cleanSingleTag('???')).toBeNull();
      expect(cleanSingleTag('')).toBeNull();
      expect(cleanSingleTag('   ')).toBeNull();
    });
  });

  describe('6. Ingestion Stage Parity (commit.stage toItemData)', () => {
    it('should populate tags, labels, and keywords consistently from metadata', () => {
      const metadata: any = {
        title: 'Attention Is All You Need',
        tags: ['Deep Learning', 'n/a', 'Transformer', 'doi: 10.1234/567'],
      };
      const itemData = toItemData(metadata);

      expect(itemData.tags).toEqual(['Deep Learning', 'Transformer']);
      expect(itemData.labels).toEqual(['Deep Learning', 'Transformer']);
      expect(itemData.keywords).toEqual(['Deep Learning', 'Transformer']);
    });
  });

  describe('7. ItemsMapper Consistency & Elimination of Fallback Revival', () => {
    it('should never revive junk tags in zoteroTags via || rawName when itemTags relation is present', () => {
      const rawItem: any = {
        id: '123e4567-e89b-12d3-a456-426614174000',
        title: 'Test Paper',
        itemTags: [
          { tag: { name: 'Deep Learning', type: 'manual' } },
          { tag: { name: 'n/a', type: 'automatic' } },
          { tag: { name: 'doi: 10.1038/xyz', type: 'automatic' } },
          { tag: { name: 'COVID-19', type: 'manual' } },
        ],
      };

      const mapped = ItemsMapper.mapFlattenedState(rawItem, 'user-1');

      expect(mapped.tags).toEqual(['Deep Learning', 'COVID-19']);
      expect(mapped.zoteroTags).toEqual([
        { tag: 'Deep Learning', type: 0 },
        { tag: 'COVID-19', type: 0 },
      ]);
    });

    it('should fallback to metadata.tags when itemTags relation is absent without reviving junk', () => {
      const rawItem: any = {
        id: '123e4567-e89b-12d3-a456-426614174001',
        title: 'Cached Paper',
        itemTags: [],
        metadata: {
          tags: ['Machine Learning', 'null', 'pp. 12-15', 'NLP'],
        },
      };

      const mapped = ItemsMapper.mapFlattenedState(rawItem, 'user-1');

      expect(mapped.tags).toEqual(['Machine Learning', 'NLP']);
      expect(mapped.zoteroTags).toEqual([
        { tag: 'Machine Learning', type: 0 },
        { tag: 'NLP', type: 0 },
      ]);
    });
  });
});
