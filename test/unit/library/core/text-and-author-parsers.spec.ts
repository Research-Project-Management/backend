import {
  normalizeDoi,
  deriveDoiFromPublisherUrl,
  deriveDirectPdfUrl,
  normalizeArxivId,
  yearFromArxivId,
  normalizeIsbn,
  isValidIsbnChecksum,
  normalizeIssn,
  normalizePmid,
  normalizePmcid,
  generateCitationKey,
  cleanAuthorName,
  splitAuthorString,
  parseCreatorString,
  isNoiseAuthorName,
  isInstitutionName,
  isVietnameseName,
  hasVietnameseDiacritics,
  extractFamilyName,
  sanitizeItemTitle,
  cleanAbstractText,
  cleanSingleTag,
  normalizeTags,
  toCanonicalTagKey,
  resolveArxivTaxonomyTag,
  stripLatexMarkup,
  stripTagPrefixes,
  MAX_TAG_LENGTH,
  RegexExtractor,
  SearchQueryEngine,
  formatAttachmentFilename,
  DEFAULT_RENAME_PATTERN,
  buildAnnotationSortIndex,
  parseAnnotationSortIndex,
  buildTipTapDocFromText,
  extractPlainTextFromTipTap,
  stripNoteHtml,
} from '@/modules/library/core';

describe('Library Core — Identifiers, Authors, Text Cleaning, Tags, Regex & Renamer', () => {
  describe('Identifiers & Citation Keys', () => {
    it('normalizes DOIs (including SICI), derives DOIs and direct PDF URLs, and validates arXiv, ISBN-10/13, ISSN, PMID, and PMCID', () => {
      expect(
        normalizeDoi(
          'https://dx.doi.org/10.1002/(SICI)1097-0258(19980815/30)17:15/16<1661::AID-SIM879>3.0.CO;2-2.',
        ),
      ).toBe(
        '10.1002/(sici)1097-0258(19980815/30)17:15/16<1661::aid-sim879>3.0.co;2-2',
      );
      expect(
        deriveDoiFromPublisherUrl(
          'https://www.nature.com/articles/s41586-021-03819-2',
        ),
      ).toBe('10.1038/s41586-021-03819-2');
      expect(
        deriveDoiFromPublisherUrl(
          'https://dl.acm.org/doi/pdf/10.1145/3442188.3445922?download=true',
        ),
      ).toBe('10.1145/3442188.3445922');
      expect(deriveDirectPdfUrl('https://arxiv.org/abs/2303.08774v2')).toBe(
        'https://arxiv.org/pdf/2303.08774v2.pdf',
      );
      expect(
        deriveDirectPdfUrl(
          'https://www.biorxiv.org/content/10.1101/2023.05.10.540123v1',
        ),
      ).toBe(
        'https://www.biorxiv.org/content/10.1101/2023.05.10.540123v1.full.pdf',
      );

      expect(normalizeArxivId('arXiv:2303.08774v3 [cs.CL]')).toBe(
        '2303.08774v3',
      );
      expect(
        normalizeArxivId('https://arxiv.org/pdf/hep-th/9901001v2.pdf', {
          stripVersion: true,
        }),
      ).toBe('hep-th/9901001');
      expect(yearFromArxivId('2303.08774')).toBe(2023);
      expect(yearFromArxivId('hep-th/9901001')).toBe(1999);

      expect(normalizeIsbn('ISBN-10: 0-306-40615-2')).toBe('0306406152');
      expect(isValidIsbnChecksum('0306406152')).toBe(true);
      expect(isValidIsbnChecksum('0306406153')).toBe(false);
      expect(isValidIsbnChecksum('043942089X')).toBe(true);
      expect(isValidIsbnChecksum('9780306406157')).toBe(true);
      expect(normalizeIssn('ISSN 0378-5955')).toBe('0378-5955');
      expect(normalizePmid('PMID: 34567890')).toBe('34567890');
      expect(normalizePmcid('PMC9876543')).toBe('PMC9876543');

      expect(
        generateCitationKey({
          authors: ['Schrödinger, Erwin'],
          year: 2024,
          title: 'The Quantum Cat Paradox in Modern Physics',
        }),
      ).toBe('schrodinger2024quantum');
    });
  });

  describe('Author, Vietnamese & Institutional Name Parsing', () => {
    it('cleans affiliations/titles, filters OCR noise, splits multi-author strings, and handles Vietnamese & institutional names', () => {
      expect(cleanAuthorName('Karen Simonyan 1,2*')).toBe('Karen Simonyan');
      expect(
        cleanAuthorName(
          'Prof. Dr. Geoffrey E. Hinton (corresponding author) <hinton@cs.toronto.edu>',
        ),
      ).toBe('Geoffrey E. Hinton');
      expect(cleanAuthorName('Martin Luther King Jr.')).toBe(
        'Martin Luther King Jr.',
      );
      expect(isNoiseAuthorName('A B S T R A C T')).toBe(true);
      expect(isNoiseAuthorName('Department of Engineering Science')).toBe(true);
      expect(isInstitutionName('World Health Organization')).toBe(true);

      expect(
        splitAuthorString(
          'Karen Simonyan, Andrew Zisserman, A BSTRACT, Visual Geometry Group',
        ),
      ).toEqual(['Karen Simonyan', 'Andrew Zisserman']);
      expect(
        splitAuthorString('Vaswani, A., Shazeer, N., Parmar, N.'),
      ).toEqual(['Vaswani, A.', 'Shazeer, N.', 'Parmar, N.']);
      expect(splitAuthorString('Martin Luther King, Jr.')).toEqual([
        'Martin Luther King, Jr.',
      ]);

      expect(parseCreatorString('Knuth, Donald E.')).toMatchObject({
        firstName: 'Donald E.',
        lastName: 'Knuth',
        fullName: 'Donald E. Knuth',
      });
      expect(parseCreatorString('Google DeepMind')).toMatchObject({
        fieldMode: 1,
        fullName: 'Google DeepMind',
      });

      expect(isVietnameseName('Nguyễn Văn An')).toBe(true);
      expect(isVietnameseName('Nguyen Van An')).toBe(true);
      expect(isVietnameseName('Karen Simonyan')).toBe(false);
      expect(hasVietnameseDiacritics('Nguyễn')).toBe(true);
      expect(parseCreatorString('Nguyễn Văn An')).toMatchObject({
        lastName: 'Nguyễn',
        firstName: 'Văn An',
        fullName: 'Nguyễn Văn An',
        fieldMode: 0,
      });
      expect(
        parseCreatorString('Nguyễn Văn An', 0, 'author', {
          preferSingleFieldForVietnamese: true,
        }),
      ).toMatchObject({
        fieldMode: 1,
        lastName: 'Nguyễn Văn An',
        firstName: '',
      });
      expect(extractFamilyName('Nguyễn Văn An')).toBe('Nguyễn');
      expect(extractFamilyName('Donald E. Knuth')).toBe('Knuth');
    });
  });

  describe('Title & Academic Abstract Normalization', () => {
    it('sanitizes HTML/XSS, LaTeX braces, control chars, and OCR spaced hyphens in titles', () => {
      expect(
        sanitizeItemTitle('<script>alert("xss")</script>Attention Is All You Need'),
      ).toBe('Attention Is All You Need');
      expect(
        sanitizeItemTitle('{Deep Learning} &amp; {Neural Networks}&#39; Future'),
      ).toBe("Deep Learning & Neural Networks' Future");
      expect(
        sanitizeItemTitle(
          'Very Deep Convolutional Networks for Large - Scale Image Recognition',
        ),
      ).toBe(
        'Very Deep Convolutional Networks for Large-Scale Image Recognition',
      );
      expect(sanitizeItemTitle('   ')).toBe('');
      expect(sanitizeItemTitle('A'.repeat(1200))).toHaveLength(1000);
    });

    it('preserves LaTeX/JATS math, converts sub/sup Unicode, normalizes PubMed/JATS headings, strips copyright/correspondence noise, and dehyphenates wraps', () => {
      expect(
        cleanAbstractText(
          '{Deep Learning} models achieve results when $f(x) = \\sigma(W^T x + b)$.',
        ),
      ).toBe(
        'Deep Learning models achieve results when $f(x) = \\sigma(W^T x + b)$.',
      );
      expect(
        cleanAbstractText(
          '<jats:p>We investigate the group <jats:inline-formula><jats:tex-math>\\mathcal{G}_n</jats:tex-math></jats:inline-formula> under rotation.</jats:p>',
        ),
      ).toBe('We investigate the group $\\mathcal{G}_n$ under rotation.');
      expect(
        cleanAbstractText(
          'The reaction between H<sub>2</sub>O and CO<sub>2</sub> with 10<sup>-5</sup> mol/L.',
        ),
      ).toBe('The reaction between H₂O and CO₂ with 10⁻⁵ mol/L.');
      expect(
        cleanAbstractText(
          '<AbstractText Label="BACKGROUND">Hypertension affects millions worldwide.</AbstractText>\n<AbstractText Label="RESULTS">Blood pressure decreased significantly.</AbstractText>',
        ),
      ).toBe(
        '**BACKGROUND:** Hypertension affects millions worldwide.\n\n**RESULTS:** Blood pressure decreased significantly.',
      );
      expect(
        cleanAbstractText(
          'Our findings confirm the hypothesis. © 2023 Elsevier B.V. All rights reserved.',
        ),
      ).toBe('Our findings confirm the hypothesis.');
      expect(
        cleanAbstractText(
          'We introduce a self-atten-\ntion mechanism for stochas-\ntic gradient descent.',
        ),
      ).toBe(
        'We introduce a self-attention mechanism for stochastic gradient descent.',
      );
      expect(cleanAbstractText('n/a')).toBeUndefined();
    });
  });

  describe('Academic Tag Normalization & Subject Taxonomy', () => {
    it('preserves scientific casing, expands arXiv taxonomy codes, splits compound tags safely, and rejects junk identifiers/dates/noise', () => {
      expect(cleanSingleTag('CRISPR-Cas9')).toBe('CRISPR-Cas9');
      expect(cleanSingleTag('Cafe\u0301   Rese\u0301au')).toBe('Café Reséau');
      expect(cleanSingleTag('a'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
      expect(toCanonicalTagKey('Café   NeurIPS')).toBe('cafe neurips');

      expect(cleanSingleTag('cs.AI')).toBe(
        'Computer Science - Artificial Intelligence',
      );
      expect(resolveArxivTaxonomyTag('q-bio.NC')).toBe(
        'Quantitative Biology - Neurons and Cognition',
      );

      expect(
        normalizeTags([
          'TCP/IP; Client/Server architecture | iclr, ICLR • Robotics / RL',
        ]),
      ).toEqual(['TCP/IP', 'Client/Server architecture', 'ICLR', 'Robotics', 'RL']);

      expect(stripLatexMarkup('{\\bf Deep Learning}')).toBe('Deep Learning');
      expect(stripTagPrefixes('Keywords: Transformer')).toBe('Transformer');

      for (const junk of [
        'doi: 10.1038/s41586-020-2649-2',
        'pmid: 12345678',
        'isbn: 978-3-16-148410-0',
        'http://example.com/paper.pdf',
        'n/a',
        'all rights reserved',
        'pp. 12-15',
        '2024-05-12',
        '...',
      ]) {
        expect(cleanSingleTag(junk)).toBeNull();
      }
    });
  });

  describe('RegexExtractor, SearchQueryEngine & Attachment Renamer', () => {
    it('disambiguates publication DOI vs cited DOIs/arXiv IDs and extracts IEEE/ACM stamps and line-anchored keywords', () => {
      const page1 = `
        Nature Biotechnology
        DOI: 10.1038/s41587-023-01987-x
        High-Throughput Genome Sequencing in Agriculture
        Abstract
        We report a scalable pipeline for crop genomic analysis in modern agriculture.
        Keywords: Deep Learning, cs.CV, Multidisciplinary, General Medicine
        1. Introduction
        As pioneered in [1] (Le et al., doi: 10.1016/j.cell.2018.05.012, arXiv:1301.3557).
      `;
      const res = RegexExtractor.scan(page1);
      expect(res.doi).toBe('10.1038/s41587-023-01987-x');
      expect(res.arxivId).toBeUndefined();
      expect(res.keywords).toEqual([
        'Deep Learning',
        'Computer Science - Computer Vision and Pattern Recognition',
      ]);

      const preprint = RegexExtractor.scan(
        'arXiv:2303.08774v2 [cs.CV] 15 Mar 2023\nScaling Vision Transformers',
      );
      expect(preprint.arxivId).toBe('2303.08774v2');
      expect(preprint.primaryCategory).toBe('cs.CV');
      expect(preprint.doi).toBe('10.48550/arXiv.2303.08774v2');

      const ieee = RegexExtractor.scan(
        'IEEE Transactions on Pattern Analysis and Machine Intelligence, vol. 44, no. 12, pp. 9123-9135, Dec. 2022.',
      );
      expect(ieee).toMatchObject({
        publisher: 'IEEE',
        volume: '44',
        issue: '12',
        pages: '9123-9135',
        year: 2022,
      });
    });

    it('extracts search identifiers, strips diacritics, guards against ReDoS regexes, and formats Zotero 7 filenames & TipTap notes', () => {
      const extracted = SearchQueryEngine.extractIdentifiers(
        'Find doi:10.1038/nature14539 or arXiv:2303.08774v2 and PMID: 38123456 ISBN 978-0-306-40615-7',
      );
      expect(extracted).toMatchObject({
        cleanDoi: '10.1038/nature14539',
        cleanArxiv: '2303.08774v2',
        cleanArxivBase: '2303.08774',
        cleanPmid: '38123456',
        cleanIsbn: '9780306406157',
      });
      expect(
        SearchQueryEngine.stripDiacritics('Schrödinger & Nguyễn Đặng'),
      ).toBe('Schrodinger & Nguyen Dang');
      expect(SearchQueryEngine.isSafeRegex('(a+)+$')).toBe(false);
      expect(SearchQueryEngine.parseSafeRegex('/(a+)+$/i')).toBeNull();
      expect(
        SearchQueryEngine.parseSafeRegex('/^Transformer\\s+Models$/i'),
      ).toBeInstanceOf(RegExp);

      expect(
        formatAttachmentFilename(
          DEFAULT_RENAME_PATTERN,
          {
            title: 'BERT: Pre-training of Deep Bidirectional Transformers',
            year: 2019,
            contributors: [
              {
                fullName: 'Jacob Devlin',
                lastName: 'Devlin',
                creatorType: 'author',
                orderIndex: 0,
              },
            ],
          },
          'file.pdf',
        ),
      ).toBe(
        'Devlin - 2019 - BERT Pre-training of Deep Bidirectional Transformers.pdf',
      );

      expect(
        formatAttachmentFilename(
          '{{ authors suffix=" - " }}{{ year suffix=" - " }}{{ title }}',
          {
            title: 'Generative Adversarial Nets',
            year: 2014,
            contributors: [
              { lastName: 'Goodfellow', creatorType: 'author', orderIndex: 0 },
              {
                lastName: 'Pouget-Abadie',
                creatorType: 'author',
                orderIndex: 1,
              },
              { lastName: 'Mirza', creatorType: 'author', orderIndex: 2 },
            ],
          },
          'doc.pdf',
        ),
      ).toBe('Goodfellow et al. - 2014 - Generative Adversarial Nets.pdf');

      const sortIdx = buildAnnotationSortIndex(12, 0.0129, 0, 340);
      expect(sortIdx).toBe('00012|000340|00129');
      expect(parseAnnotationSortIndex(sortIdx)).toEqual({
        page: 12,
        charOffset: 340,
        y: 0.0129,
        x: 0,
      });

      const doc = buildTipTapDocFromText('Para 1.\n\nPara 2.');
      expect(extractPlainTextFromTipTap(doc)).toBe('Para 1.\n\nPara 2.');
      expect(
        stripNoteHtml('<p>Hello <b>world</b><script>alert(1)</script></p>'),
      ).toBe('Hello world');
    });
  });
});
