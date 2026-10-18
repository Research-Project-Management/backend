import {
  cleanSingleTag,
  normalizeAcademicTags,
  normalizeTags,
  toCanonicalTagKey,
  resolveArxivTaxonomyTag,
  stripLatexMarkup,
  stripTagPrefixes,
  MAX_TAG_LENGTH,
} from '@/modules/library/core/domain/tag.domain';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';

describe('Library Academic Tag & Subject Taxonomy Engine', () => {
  describe('1. Case-Preserving Unicode NFC Tag Normalization', () => {
    it('should preserve exact orthographic casing of scientific acronyms, mixed-case models, bio-terms, and author keywords', () => {
      // Exact case preservation for acronyms & conferences
      expect(cleanSingleTag('ICLR')).toBe('ICLR');
      expect(cleanSingleTag('ICML')).toBe('ICML');
      expect(cleanSingleTag('CVPR')).toBe('CVPR');
      expect(cleanSingleTag('IEEE')).toBe('IEEE');
      expect(cleanSingleTag('ACM')).toBe('ACM');
      expect(cleanSingleTag('COVID-19')).toBe('COVID-19');

      // Exact case preservation for mixed-case terms without relying on static whitelists
      expect(cleanSingleTag('NeurIPS')).toBe('NeurIPS');
      expect(cleanSingleTag('ImageNet')).toBe('ImageNet');
      expect(cleanSingleTag('GoogLeNet')).toBe('GoogLeNet');
      expect(cleanSingleTag('AlphaFold')).toBe('AlphaFold');
      expect(cleanSingleTag('LoRA')).toBe('LoRA');
      expect(cleanSingleTag('QLoRA')).toBe('QLoRA');
      expect(cleanSingleTag('mRNA')).toBe('mRNA');
      expect(cleanSingleTag('siRNA')).toBe('siRNA');
      expect(cleanSingleTag('CRISPR-Cas9')).toBe('CRISPR-Cas9');
      expect(cleanSingleTag('fMRI')).toBe('fMRI');
      expect(cleanSingleTag('p53')).toBe('p53');
      expect(cleanSingleTag('t-SNE')).toBe('t-SNE');
      expect(cleanSingleTag('k-NN')).toBe('k-NN');
      expect(cleanSingleTag('SimCLR')).toBe('SimCLR');
      expect(cleanSingleTag('eBPF')).toBe('eBPF');

      // Exact case preservation for researcher/author keywords
      expect(cleanSingleTag('machine learning')).toBe('machine learning');
      expect(cleanSingleTag('Machine Learning')).toBe('Machine Learning');
      expect(cleanSingleTag('deep reinforcement learning')).toBe(
        'deep reinforcement learning',
      );
      expect(cleanSingleTag('Nature')).toBe('Nature');
      expect(cleanSingleTag('Science')).toBe('Science');
      expect(cleanSingleTag('Must-Read')).toBe('Must-Read');
    });

    it('should normalize Unicode NFC, collapse internal whitespace, and enforce maximum tag length (255 chars)', () => {
      const decomposed = 'Cafe\u0301   Rese\u0301au';
      expect(cleanSingleTag(decomposed)).toBe('Café Reséau');

      expect(cleanSingleTag('a'.repeat(MAX_TAG_LENGTH))).toHaveLength(
        MAX_TAG_LENGTH,
      );
      expect(cleanSingleTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
    });

    it('should compute diacritic- and case-insensitive canonical identity keys (`toCanonicalTagKey`)', () => {
      expect(toCanonicalTagKey('Café   NeurIPS')).toBe('cafe neurips');
      expect(toCanonicalTagKey('ICLR')).toBe('iclr');
    });
  });

  describe('2. Subject Taxonomy Code Resolution (`resolveArxivTaxonomyTag`)', () => {
    it('should expand arXiv classification codes into structured `"<Archive> - <Sub-Discipline>"` descriptors', () => {
      expect(cleanSingleTag('cs.AI')).toBe(
        'Computer Science - Artificial Intelligence',
      );
      expect(cleanSingleTag('cs.CL')).toBe(
        'Computer Science - Computation and Language',
      );
      expect(cleanSingleTag('cs.CE')).toBe(
        'Computer Science - Computational Engineering, Finance, and Science',
      );
      expect(cleanSingleTag('cs.DC')).toBe(
        'Computer Science - Distributed, Parallel, and Cluster Computing',
      );
      expect(cleanSingleTag('cs.FL')).toBe(
        'Computer Science - Formal Languages and Automata Theory',
      );
      expect(cleanSingleTag('stat.ML')).toBe('Statistics - Machine Learning');
      expect(cleanSingleTag('stat.AP')).toBe('Statistics - Applications');
      expect(cleanSingleTag('physics.data-an')).toBe(
        'Physics - Data Analysis, Statistics and Probability',
      );
      expect(cleanSingleTag('astro-ph.CO')).toBe(
        'Astrophysics - Cosmology and Nongalactic Astrophysics',
      );
      expect(cleanSingleTag('cs-cv')).toBe(
        'Computer Science - Computer Vision and Pattern Recognition',
      );
      expect(resolveArxivTaxonomyTag('math.ST')).toBe(
        'Mathematics - Statistics Theory',
      );
    });
  });

  describe('3. Compound Tag Splitting, Deduplication & Safe Slash Handling', () => {
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

    it('should preserve safe domain slashes without spaces (e.g. TCP/IP, Client/Server architecture)', () => {
      const raw = 'TCP/IP; Client/Server architecture';
      const result = normalizeAcademicTags([raw]);
      expect(result).toEqual(['TCP/IP', 'Client/Server architecture']);
    });

    it('should deduplicate case-insensitively and upgrade all-lowercase tag if explicit uppercase/mixed-case appears in the same batch', () => {
      const result = normalizeAcademicTags([
        'iclr',
        'ICLR',
        'neurips',
        'NeurIPS',
        'deep learning',
        'DEEP LEARNING',
      ]);
      expect(result).toEqual(['ICLR', 'NeurIPS', 'DEEP LEARNING']);
    });
  });

  describe('4. LaTeX & HTML Markup Sanitization', () => {
    it('should strip LaTeX formatting commands, macros, braces, HTML tags, and escaped characters', () => {
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
      expect(cleanSingleTag('<span>GraphQL</span>')).toBe('GraphQL');
      expect(stripTagPrefixes('Keywords: Transformer')).toBe('Transformer');
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

    it('should reject pagination, volume, issue, and lowercase standalone Roman numerals', () => {
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

  describe('8. AcademicRegexCatalog Keywords Boundary & ASJC Noise Filtering', () => {
    it('should not extract mid-sentence "keywords" in prose as tags, and should extract line-anchored Keywords', async () => {
      const { AcademicRegexCatalog } =
        await import('@/modules/library/core/domain/academic-regex.catalog');

      const proseWithMidSentenceKeywords =
        'Abstract: In this paper we study how search keywords in large database systems affect query latency.\n' +
        'Keywords: Deep Learning, Convolutional Neural Networks, cs.CV, Multidisciplinary, General Medicine';

      const scanned = AcademicRegexCatalog.scan(proseWithMidSentenceKeywords);
      expect(scanned.keywords).toEqual([
        'Deep Learning',
        'Convolutional Neural Networks',
        'Computer Science - Computer Vision and Pattern Recognition',
      ]);
    });
  });

  describe('9. CslParser & NormalizationPolicy Note / Extra Separation', () => {
    it('should strip promoted PMID/PMCID/arXiv lines from CSL note and preserve annote as notes', async () => {
      const { CslParser } =
        await import('@/modules/library/ingestion/parsers/csl.parser');
      const parser = new CslParser();
      const parsed = parser.parse([
        {
          type: 'article-journal',
          title: 'Very Deep Convolutional Networks',
          note: 'PMID: 12345678\narXiv: 1409.1556 [cs.CV]\nOriginal Date: 2014',
          annote:
            '<p>First paragraph of literature note.</p><p>Second paragraph with <strong>bold</strong> text.</p>',
          keyword: 'cs.CV; deep learning; null; multidisciplinary',
        },
      ]);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].pmid).toBe('12345678');
      expect(parsed[0].arxivId).toBe('1409.1556');
      expect(parsed[0].extra).toBe('Original Date: 2014');
      expect(parsed[0].notes).toEqual([
        '<p>First paragraph of literature note.</p><p>Second paragraph with <strong>bold</strong> text.</p>',
      ]);
      expect(parsed[0].tags).toEqual([
        'Computer Science - Computer Vision and Pattern Recognition',
        'deep learning',
      ]);
    });

    it('should preserve multi-paragraph structure and convert HTML to Markdown in NormalizationPolicy.normalize', async () => {
      const { NormalizationPolicy } =
        await import('@/modules/library/ingestion/policies/normalization.policy');
      const policy = new NormalizationPolicy();
      const normalized = policy.normalize({
        title: 'Test Note Formatting',
        notes: [
          '<p>First paragraph of literature note.</p><p>Second paragraph with <strong>bold</strong> text.</p>',
          { content: 'Comment: 14 pages, 6 figures', source: 'arXiv' },
          { content: 'Comment: 14 pages, 6 figures', source: 'arXiv' },
        ],
      });

      expect(normalized.notes).toHaveLength(2);
      expect(normalized.notes?.[0]).toEqual({
        content:
          'First paragraph of literature note.\n\nSecond paragraph with **bold** text.',
      });
      expect(normalized.notes?.[1]).toEqual({
        content: 'Comment: 14 pages, 6 figures',
        source: 'arXiv',
      });
    });
  });
});
