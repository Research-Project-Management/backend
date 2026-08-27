import { CitationProjectionService } from '@/modules/library/legacy/cite/cite.service';
import { CslFormatter } from '@/modules/library/legacy/cite/formatters/csl.formatter';
import { BibtexFormatter } from '@/modules/library/legacy/cite/formatters/bibtex.formatter';
import { RisFormatter } from '@/modules/library/legacy/cite/formatters/ris.formatter';
import { MapperService as ReferenceManagerMapperService } from '@/modules/library/legacy/cite/mapper.service';

describe('CitationProjectionService (Standard Multi-Format Export & Caching)', () => {
  let service: CitationProjectionService;
  let cslFormatter: CslFormatter;
  let bibtexFormatter: BibtexFormatter;
  let risFormatter: RisFormatter;
  let refMapper: ReferenceManagerMapperService;
  let mockRedis: any;

  beforeEach(() => {
    cslFormatter = new CslFormatter();
    bibtexFormatter = new BibtexFormatter();
    risFormatter = new RisFormatter();
    refMapper = new ReferenceManagerMapperService();

    mockRedis = {
      isReady: jest.fn().mockReturnValue(true),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(true),
    };

    service = new CitationProjectionService(
      {} as any, // catalogRepo
      bibtexFormatter,
      {} as any, // bibtexParser
      {} as any, // doiResolver
      cslFormatter,
      risFormatter,
      refMapper,
      mockRedis,
    );
  });

  const samplePaper = {
    id: 'paper-attention-2017',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
    year: 2017,
    journal: 'Advances in Neural Information Processing Systems',
    doi: '10.5555/3295222.3295349',
    citationKey: 'vaswani2017attention',
    extra: 'arXiv: 1706.03762',
    version: 1,
  };

  it('renders citation in APA style and caches the result', async () => {
    const formatSpy = jest.spyOn(cslFormatter, 'formatEntry');

    const result1 = await service.projectCitation(samplePaper, 'apa');
    expect(result1.style).toBe('apa');
    expect(result1.bibliography).toContain('Vaswani');
    expect(result1.bibliography).toContain('(2017)');
    expect(formatSpy).toHaveBeenCalledTimes(1);

    // Second call with same version should hit in-memory cache
    const result2 = await service.projectCitation(samplePaper, 'apa');
    expect(result2).toEqual(result1);
    expect(formatSpy).toHaveBeenCalledTimes(1); // Not called again!
  });

  it('renders citations across all major styles (IEEE, Nature, Chicago, MLA, Vancouver)', async () => {
    const projection = await service.projectAllStyles(samplePaper);

    expect(projection.citationKey).toBe('vaswani2017attention');
    expect(projection.apa.bibliography).toContain('Attention Is All You Need');
    expect(projection.ieee.bibliography).toContain('A. Vaswani');
    expect(projection.nature.bibliography).toBeDefined();
    expect(projection.chicago.bibliography).toBeDefined();
    expect(projection.mla.bibliography).toBeDefined();
    expect(projection.vancouver.bibliography).toBeDefined();

    // Export formats
    expect(projection.bibtex).toContain('@article{vaswani2017attention');
    expect(projection.biblatex).toContain('eprint = {1706.03762}');
    expect(projection.biblatex).toContain('eprinttype = {arXiv}');
    expect(projection.ris).toContain('TY  - JOUR');
    expect(projection.cslJson.title).toBe('Attention Is All You Need');
  });

  it('projects batch BibTeX and RIS exports', () => {
    const items = [
      samplePaper,
      {
        id: 'paper-bert-2018',
        title: 'BERT: Pre-training of Deep Bidirectional Transformers',
        authors: ['Devlin, Jacob', 'Chang, Ming-Wei'],
        year: 2018,
        citationKey: 'devlin2018bert',
      },
    ];

    const bibtex = service.projectBibtex(items);
    expect(bibtex).toContain('vaswani2017attention');
    expect(bibtex).toContain('devlin2018bert');

    const ris = service.projectRis(items);
    expect(ris).toContain('ER  -');
  });
});
