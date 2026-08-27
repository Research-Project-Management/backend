import { MapperService as ReferenceManagerMapperService } from '@/modules/library/legacy/cite/mapper.service';
import { UnifiedAcademicMetadata } from '@/modules/library/legacy/metadata/types/metadata.types';

describe('ReferenceManagerMapperService (Reference Manager Schema & CSL JSON)', () => {
  let mapper: ReferenceManagerMapperService;

  beforeEach(() => {
    mapper = new ReferenceManagerMapperService();
  });

  const sampleMetadata: UnifiedAcademicMetadata = {
    doi: '10.5555/3295222.3295349',
    arxivId: '1706.03762',
    pmid: '29124373',
    isbn: '9781510860964',
    issn: '1049-5258',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
    editors: ['Guyon, I.'],
    year: 2017,
    itemType: 'conferencePaper',
    publicationTitle: 'Advances in Neural Information Processing Systems 30',
    publisher: 'Curran Associates, Inc.',
    pages: '5998-6008',
    citationKey: 'vaswani2017attention',
    tags: ['Neural Networks', 'Attention Mechanism'],
  };

  describe('Reference Manager Standard Mapping', () => {
    it('converts UnifiedAcademicMetadata to Reference Manager format', () => {
      const refItem = mapper.toReferenceItem(sampleMetadata);

      expect(refItem.itemType).toBe('conferencePaper');
      expect(refItem.title).toBe('Attention Is All You Need');
      expect(refItem.creators.length).toBe(4); // 3 authors + 1 editor

      const firstAuthor = refItem.creators[0];
      expect(firstAuthor.creatorType).toBe('author');
      expect(firstAuthor.lastName).toBe('Vaswani');
      expect(firstAuthor.firstName).toBe('Ashish');

      const editor = refItem.creators[3];
      expect(editor.creatorType).toBe('editor');
      expect(editor.lastName).toBe('Guyon');

      expect(refItem.DOI).toBe('10.5555/3295222.3295349');
      expect(refItem.ISBN).toBe('9781510860964');
      expect(refItem.ISSN).toBe('1049-5258');
      expect(refItem.tags?.length).toBe(2);
      expect(refItem.tags?.[0].tag).toBe('Neural Networks');

      // Extra field contains formatted lines
      expect(refItem.extra).toContain('Citation Key: vaswani2017attention');
      expect(refItem.extra).toContain('arXiv: 1706.03762');
      expect(refItem.extra).toContain('PMID: 29124373');
    });

    it('converts Reference Manager item back to UnifiedAcademicMetadata (bidirectional stability)', () => {
      const refItem = mapper.toReferenceItem(sampleMetadata);
      const restored = mapper.fromReferenceItem(refItem);

      expect(restored.doi).toBe(sampleMetadata.doi);
      expect(restored.isbn).toBe(sampleMetadata.isbn);
      expect(restored.issn).toBe(sampleMetadata.issn);
      expect(restored.pmid).toBe(sampleMetadata.pmid);
      expect(restored.arxivId).toBe(sampleMetadata.arxivId);
      expect(restored.citationKey).toBe(sampleMetadata.citationKey);
      expect(restored.title).toBe(sampleMetadata.title);
      expect(restored.year).toBe(sampleMetadata.year);
      expect(restored.itemType).toBe(sampleMetadata.itemType);
      expect(restored.authors.length).toBe(3);
      expect(restored.editors?.length).toBe(1);
    });
  });

  describe('CSL JSON Mapping', () => {
    it('converts UnifiedAcademicMetadata to CSL JSON Item', () => {
      const csl = mapper.toCslJson(sampleMetadata);

      expect(csl.type).toBe('paper-conference');
      expect(csl.title).toBe('Attention Is All You Need');
      expect(csl.author?.length).toBe(3);
      expect(csl.author?.[0].family).toBe('Vaswani');
      expect(csl.author?.[0].given).toBe('Ashish');
      expect(csl.editor?.length).toBe(1);
      expect(csl.editor?.[0].family).toBe('Guyon');
      expect(csl.issued?.['date-parts']?.[0]?.[0]).toBe(2017);
      expect(csl.page).toBe('5998-6008');
      expect(csl.DOI).toBe('10.5555/3295222.3295349');
    });

    it('converts CSL JSON Item back to UnifiedAcademicMetadata', () => {
      const csl = mapper.toCslJson(sampleMetadata);
      const restored = mapper.fromCslJson(csl);

      expect(restored.doi).toBe(sampleMetadata.doi);
      expect(restored.title).toBe(sampleMetadata.title);
      expect(restored.itemType).toBe(sampleMetadata.itemType);
      expect(restored.year).toBe(sampleMetadata.year);
      expect(restored.authors.length).toBe(3);
      expect(restored.editors?.length).toBe(1);
    });
  });
});
