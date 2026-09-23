/**
 * test/unit/manuscripts-citations.service.spec.ts
 * Comprehensive Unit Test Suite for Manuscripts Citations Subsystem
 * Testing BibTeX AST Parser, DOI/arXiv Academic Resolver, Aggregator, Library Sync,
 * Use Cases, Facade Service, and Controllers.
 */

import {
  CitationKeyVo,
  AcademicIdentifierVo,
  AuthorListVo,
  BibEntry,
  BibliographyFile,
  DuplicateCitationKeyException,
  IdentifierNotFoundException,
  InvalidBibtexException,
  RegexAstBibtexParser,
  CrossrefArxivResolverAdapter,
  PluggableLibrarySyncAdapter,
  ManuscriptBibAggregatorAdapter,
  SearchCitationKeysUseCase,
  ResolveIdentifierToBibUseCase,
  ValidateProjectBibtexUseCase,
  SyncLibraryCollectionUseCase,
  CitationsService,
  CitationsController,
  CitationsUtilityController,
  ICitationsAggregatorPort,
} from '@/modules/manuscripts/citations';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('Manuscripts Citations Subsystem (BibTeX, DOI/arXiv & Library Sync)', () => {
  // =========================================================================
  // 1. DOMAIN LAYER: VALUE OBJECTS & ENTITIES
  // =========================================================================
  describe('Domain Value Objects & Entities', () => {
    describe('CitationKeyVo', () => {
      it('should sanitize and normalize valid citation keys', () => {
        const key = CitationKeyVo.create('vaswani2017attention');
        expect(key.value).toBe('vaswani2017attention');
        expect(key.equals(CitationKeyVo.create('vaswani2017attention'))).toBe(true);
      });

      it('should sanitize strings into valid citation keys', () => {
        const sanitized = CitationKeyVo.sanitize('Vaswani et al. (2017)!');
        expect(sanitized).toBe('Vaswani_et_al._2017');
        const key = CitationKeyVo.create(sanitized);
        expect(key.value).toBe('Vaswani_et_al._2017');
      });

      it('should throw InvalidBibtexException on empty citation key', () => {
        expect(() => CitationKeyVo.create('   ')).toThrow(InvalidBibtexException);
      });
    });

    describe('AcademicIdentifierVo', () => {
      it('should parse standard DOI and DOI URLs', () => {
        const doi1 = AcademicIdentifierVo.parse('10.1145/3290605.3300244');
        expect(doi1.isDoi()).toBe(true);
        expect(doi1.clean).toBe('10.1145/3290605.3300244');

        const doiUrl = AcademicIdentifierVo.parse('https://doi.org/10.1038/nature12373');
        expect(doiUrl.isDoi()).toBe(true);
        expect(doiUrl.clean).toBe('10.1038/nature12373');

        const doiPrefix = AcademicIdentifierVo.parse('doi:10.1000/182');
        expect(doiPrefix.isDoi()).toBe(true);
        expect(doiPrefix.clean).toBe('10.1000/182');
      });

      it('should parse arXiv IDs with prefixes and versions', () => {
        const arxiv1 = AcademicIdentifierVo.parse('1706.03762');
        expect(arxiv1.isArxiv()).toBe(true);
        expect(arxiv1.clean).toBe('1706.03762');

        const arxiv2 = AcademicIdentifierVo.parse('arXiv:1706.03762v5');
        expect(arxiv2.isArxiv()).toBe(true);
        expect(arxiv2.clean).toBe('1706.03762v5');

        const arxivUrl = AcademicIdentifierVo.parse('https://arxiv.org/abs/2103.00020');
        expect(arxivUrl.isArxiv()).toBe(true);
        expect(arxivUrl.clean).toBe('2103.00020');
      });

      it('should mark unparseable strings as unknown type', () => {
        const unknown = AcademicIdentifierVo.parse('just-some-random-string');
        expect(unknown.type).toBe('unknown');
        expect(unknown.isDoi()).toBe(false);
        expect(unknown.isArxiv()).toBe(false);
      });
    });

    describe('AuthorListVo', () => {
      it('should parse single author and format display', () => {
        const single = new AuthorListVo('Knuth, Donald E.');
        expect(single.authors).toHaveLength(1);
        expect(single.toDisplayString()).toBe('Knuth');
      });

      it('should parse two authors joined by "and"', () => {
        const two = new AuthorListVo('Vaswani, Ashish and Shazeer, Noam');
        expect(two.authors).toHaveLength(2);
        expect(two.toDisplayString()).toBe('Vaswani and Shazeer');
      });

      it('should format three or more authors with "et al."', () => {
        const multi = new AuthorListVo(
          'Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob'
        );
        expect(multi.authors).toHaveLength(4);
        expect(multi.toDisplayString()).toBe('Vaswani et al.');
      });

      it('should handle empty or whitespace author strings', () => {
        const empty = new AuthorListVo('');
        expect(empty.authors).toHaveLength(0);
        expect(empty.toDisplayString()).toBe('Unknown Author');
      });
    });

    describe('BibEntry Entity', () => {
      it('should construct aggregate, format label and output valid BibTeX', () => {
        const entry = new BibEntry({
          key: 'vaswani2017attention',
          entryType: 'article',
          fields: {
            title: 'Attention is All You Need',
            author: 'Vaswani, Ashish and Shazeer, Noam',
            journal: 'NeurIPS',
            year: '2017',
          },
        });

        expect(entry.key.value).toBe('vaswani2017attention');
        expect(entry.entryType).toBe('article');
        expect(entry.title).toBe('Attention is All You Need');
        expect(entry.year).toBe('2017');
        expect(entry.getDisplayLabel()).toContain('Vaswani and Shazeer (2017)');

        const bibText = entry.toBibtexString();
        expect(bibText).toContain('@article{vaswani2017attention,');
        expect(bibText).toContain('title = {Attention is All You Need}');
        expect(bibText).toContain('year = {2017}');
      });

      it('should produce structured JSON representation', () => {
        const entry = new BibEntry({
          key: 'goodfellow2016deep',
          entryType: 'book',
          fields: {
            title: 'Deep Learning',
            author: 'Goodfellow, Ian and Bengio, Yoshua',
            year: '2016',
          },
        });

        const json = entry.toJSON();
        expect(json.key).toBe('goodfellow2016deep');
        expect(json.entryType).toBe('book');
        expect(json.authorsDisplay).toBe('Goodfellow and Bengio');
        expect(json.authors).toEqual(['Ian Goodfellow', 'Yoshua Bengio']);
      });
    });

    describe('BibliographyFile Entity', () => {
      it('should contain entries, detect duplicates and find matches', () => {
        const e1 = new BibEntry({
          key: 'e1',
          entryType: 'article',
          fields: { title: 'First Paper', author: 'Author One', year: '2020' },
        });
        const e2 = new BibEntry({
          key: 'e2',
          entryType: 'inproceedings',
          fields: { title: 'Second Paper', author: 'Author Two', year: '2021' },
        });

        const file = new BibliographyFile({ path: '/references.bib', entries: [e1, e2] });

        expect(file.totalCount).toBe(2);
        expect(file.getEntryByKey('e1')).toBe(e1);

        // Matching query
        expect(file.findMatches('First')).toHaveLength(1);
        expect(file.findMatches('2021')).toHaveLength(1);
        expect(file.findMatches('Author')).toHaveLength(2);
        expect(file.findMatches('NonExistent')).toHaveLength(0);
      });

      it('should collect duplicate keys if duplicate keys exist', () => {
        const e1 = new BibEntry({ key: 'dupKey', entryType: 'article', fields: { title: 'Paper A' } });
        const e2 = new BibEntry({ key: 'dupKey', entryType: 'book', fields: { title: 'Paper B' } });

        const file = new BibliographyFile({ path: '/references.bib', entries: [e1, e2] });

        expect(file.duplicateKeys.length).toBeGreaterThan(0);
        expect(file.duplicateKeys).toContain('dupKey');
      });
    });
  });

  // =========================================================================
  // 2. ADAPTERS LAYER: PARSER, RESOLVER, AGGREGATOR, LIBRARY SYNC
  // =========================================================================
  describe('Adapters Layer', () => {
    describe('RegexAstBibtexParser', () => {
      let parser: RegexAstBibtexParser;

      beforeEach(() => {
        parser = new RegexAstBibtexParser();
      });

      it('should parse single entry with curly braced fields', () => {
        const raw = `@article{vaswani2017attention,
          title = {Attention is All You Need},
          author = {Vaswani, Ashish and Shazeer, Noam},
          journal = {NeurIPS},
          year = {2017}
        }`;

        const entries = parser.parse(raw);
        expect(entries).toHaveLength(1);
        const e = entries[0];
        expect(e.key.value).toBe('vaswani2017attention');
        expect(e.entryType).toBe('article');
        expect(e.fields.get('title')).toBe('Attention is All You Need');
        expect(e.fields.get('year')).toBe('2017');
      });

      it('should parse double-quoted fields and nested braces', () => {
        const raw = `@book{sample2022,
          title = "A Great \\textbf{Sample} Book",
          author = {Doe, John and {Special Group}},
          publisher = "MIT Press"
        }`;

        const entries = parser.parse(raw);
        expect(entries).toHaveLength(1);
        expect(entries[0].fields.get('title')).toBe('A Great \\textbf{Sample} Book');
        expect(entries[0].fields.get('publisher')).toBe('MIT Press');
      });

      it('should parse multiple entries separated by comments and newlines', () => {
        const raw = `
          % Comment line
          @article{key1, title = {Paper One}, year = {2021}}
          
          Random commentary text in bib file
          @inproceedings{key2, title = {Paper Two}, year = {2022}}
        `;

        const entries = parser.parse(raw);
        expect(entries).toHaveLength(2);
        expect(entries[0].key.value).toBe('key1');
        expect(entries[1].key.value).toBe('key2');
      });

      it('should format entries into standard BibTeX string', () => {
        const e1 = new BibEntry({ key: 'k1', entryType: 'article', fields: { title: 'T1' } });
        const e2 = new BibEntry({ key: 'k2', entryType: 'book', fields: { title: 'T2' } });

        const formatted = parser.format([e1, e2]);
        expect(formatted).toContain('@article{k1,');
        expect(formatted).toContain('@book{k2,');
      });

      it('should return empty array for empty input', () => {
        expect(parser.parse('')).toEqual([]);
        expect(parser.parse('    \n\t ')).toEqual([]);
      });
    });

    describe('CrossrefArxivResolverAdapter', () => {
      let resolver: CrossrefArxivResolverAdapter;
      let originalFetch: typeof global.fetch;

      beforeEach(() => {
        resolver = new CrossrefArxivResolverAdapter();
        originalFetch = global.fetch;
      });

      afterEach(() => {
        global.fetch = originalFetch;
      });

      it('should resolve DOI via Content Negotiation returning BibTeX', async () => {
        const mockBib = `@article{mock_doi,
          doi = {10.1145/123},
          title = {Resolved Via DOI},
          author = {Test, Author},
          year = {2023}
        }`;

        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: jest.fn().mockResolvedValue(mockBib),
        } as any);

        const vo = AcademicIdentifierVo.parse('10.1145/123');
        const entry = await resolver.resolve(vo);

        expect(entry).not.toBeNull();
        expect(entry!.key.value).toBe('mock_doi');
        expect(entry!.title).toBe('Resolved Via DOI');
      });

      it('should resolve DOI via CrossRef JSON fallback when BibTeX content negotiation fails', async () => {
        const mockJson = {
          message: {
            title: ['Fallback DOI Title'],
            author: [{ given: 'John', family: 'Doe' }],
            'container-title': ['Journal of AI'],
            published: { 'date-parts': [[2024]] },
            DOI: '10.1000/fallback',
          },
        };

        global.fetch = jest
          .fn()
          .mockResolvedValueOnce({ ok: false } as any) // 1st try content negotiation fails
          .mockResolvedValueOnce({
            ok: true,
            json: jest.fn().mockResolvedValue(mockJson),
          } as any);

        const vo = AcademicIdentifierVo.parse('10.1000/fallback');
        const entry = await resolver.resolve(vo);

        expect(entry).not.toBeNull();
        expect(entry!.title).toBe('Fallback DOI Title');
        expect(entry!.fields.get('journal')).toBe('Journal of AI');
        expect(entry!.year).toBe('2024');
      });

      it('should resolve arXiv via Atom XML API', async () => {
        const mockXml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <entry>
            <id>http://arxiv.org/abs/1706.03762v5</id>
            <published>2017-06-12T17:52:14Z</published>
            <title>Attention Is All You Need</title>
            <summary>The dominant sequence transduction models...</summary>
            <author><name>Ashish Vaswani</name></author>
            <author><name>Noam Shazeer</name></author>
          </entry>
        </feed>`;

        global.fetch = jest.fn().mockResolvedValue({
          ok: true,
          text: jest.fn().mockResolvedValue(mockXml),
        } as any);

        const vo = AcademicIdentifierVo.parse('1706.03762');
        const entry = await resolver.resolve(vo);

        expect(entry).not.toBeNull();
        expect(entry!.title).toBe('Attention Is All You Need');
        expect(entry!.year).toBe('2017');
        expect(entry!.fields.get('eprint')).toBe('1706.03762');
        expect(entry!.fields.get('archiveprefix')).toBe('arXiv');
      });

      it('should return null if identifier is unknown or network fails', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('Network error'));
        const voDoi = AcademicIdentifierVo.parse('10.9999/fails');
        const res = await resolver.resolve(voDoi);
        expect(res).toBeNull();

        const unknown = AcademicIdentifierVo.parse('random');
        expect(await resolver.resolve(unknown)).toBeNull();
      });
    });

    describe('PluggableLibrarySyncAdapter', () => {
      let adapter: PluggableLibrarySyncAdapter;

      beforeEach(() => {
        adapter = new PluggableLibrarySyncAdapter();
      });

      it('should list mock collections', async () => {
        const collections = await adapter.listCollections('user-1');
        expect(collections).toHaveLength(2);
        expect(collections[0].id).toBe('coll-default');
        expect(collections[0].name).toContain('Zotero');
      });

      it('should fetch valid collection BibTeX', async () => {
        const bib = await adapter.fetchCollectionBibtex('user-1', 'coll-default');
        expect(bib).toContain('vaswani2017attention');
        expect(bib).toContain('goodfellow2016deep');
      });

      it('should throw error for non-existent collection', async () => {
        await expect(adapter.fetchCollectionBibtex('user-1', 'non-existent')).rejects.toThrow(
          'Collection non-existent not found'
        );
      });
    });

    describe('ManuscriptBibAggregatorAdapter', () => {
      let structureServiceMock: any;
      let docstoreServiceMock: any;
      let parserMock: any;
      let aggregator: ManuscriptBibAggregatorAdapter;

      beforeEach(() => {
        structureServiceMock = {
          getAllNodes: jest.fn(),
          createNode: jest.fn(),
        };
        docstoreServiceMock = {
          getDoc: jest.fn(),
          updateDoc: jest.fn(),
          createDoc: jest.fn(),
        };
        parserMock = {
          parse: jest.fn(),
          format: jest.fn(),
        };

        aggregator = new ManuscriptBibAggregatorAdapter(
          structureServiceMock,
          docstoreServiceMock,
          parserMock
        );
      });

      it('should collect and parse all .bib files from project structure', async () => {
        structureServiceMock.getAllNodes.mockResolvedValue([
          { isDoc: () => true, name: 'references.bib', path: '/references.bib', docId: 'doc-1' },
          { isDoc: () => true, name: 'main.tex', path: '/main.tex', docId: 'doc-2' },
          { isDoc: () => true, name: 'extra.bib', path: '/bib/extra.bib', docId: 'doc-3' },
        ]);

        docstoreServiceMock.getDoc
          .mockResolvedValueOnce({ lines: ['@article{k1, title={T1}}'] })
          .mockResolvedValueOnce({ lines: ['@book{k2, title={T2}}'] });

        const dummyEntry1 = new BibEntry({ key: 'k1', entryType: 'article', fields: { title: 'T1' } });
        const dummyEntry2 = new BibEntry({ key: 'k2', entryType: 'book', fields: { title: 'T2' } });
        parserMock.parse
          .mockReturnValueOnce([dummyEntry1])
          .mockReturnValueOnce([dummyEntry2]);

        const files = await aggregator.collectBibFiles('proj-1');

        expect(files).toHaveLength(2);
        expect(files[0].path).toBe('/references.bib');
        expect(files[0].entries).toHaveLength(1);
        expect(files[1].path).toBe('/bib/extra.bib');
      });

      it('should append entry to existing .bib file in docstore', async () => {
        structureServiceMock.getAllNodes.mockResolvedValue([
          { isDoc: () => true, name: 'references.bib', path: '/references.bib', docId: 'doc-1' },
        ]);

        docstoreServiceMock.getDoc.mockResolvedValue({
          lines: ['@article{existing, title={Existing}}'],
          version: 2,
          rev: 'rev-2',
        });

        const newEntry = new BibEntry({
          key: 'newEntry',
          entryType: 'article',
          fields: { title: 'New Entry' },
        });

        const targetPath = await aggregator.appendEntryToBib('proj-1', newEntry, 'references.bib');

        expect(targetPath).toBe('/references.bib');
        expect(docstoreServiceMock.updateDoc).toHaveBeenCalledWith(
          'proj-1',
          'doc-1',
          expect.objectContaining({
            lines: expect.arrayContaining(['', expect.stringContaining('@article{newEntry,')]),
          })
        );
      });

      it('should create new .bib file if it does not exist', async () => {
        structureServiceMock.getAllNodes.mockResolvedValue([]);
        docstoreServiceMock.createDoc.mockResolvedValue({ _id: 'new-doc-id' });
        structureServiceMock.createNode.mockResolvedValue({ path: '/references.bib' });

        const newEntry = new BibEntry({
          key: 'brandNew',
          entryType: 'book',
          fields: { title: 'Brand New' },
        });

        const path = await aggregator.appendEntryToBib('proj-1', newEntry, 'references.bib');

        expect(path).toBe('/references.bib');
        expect(docstoreServiceMock.createDoc).toHaveBeenCalledWith('proj-1', {
          path: '/references.bib',
          lines: expect.any(Array),
        });
        expect(structureServiceMock.createNode).toHaveBeenCalledWith('proj-1', {
          path: '/references.bib',
          name: 'references.bib',
          type: 'DOC',
          docId: 'new-doc-id',
          parentId: null,
        });
      });
    });
  });

  // =========================================================================
  // 3. USE CASES LAYER
  // =========================================================================
  describe('Use Cases Layer', () => {
    let mockAggregator: jest.Mocked<ICitationsAggregatorPort>;

    beforeEach(() => {
      mockAggregator = {
        collectBibFiles: jest.fn(),
        appendEntryToBib: jest.fn(),
      };
    });

    describe('SearchCitationKeysUseCase', () => {
      it('should search across bibliography files and deduplicate keys', async () => {
        const file1 = new BibliographyFile({
          path: '/refs.bib',
          entries: [
            new BibEntry({ key: 'vaswani2017', entryType: 'article', fields: { title: 'Attention' } }),
            new BibEntry({ key: 'goodfellow2016', entryType: 'book', fields: { title: 'Deep Learning' } }),
          ],
        });

        const file2 = new BibliographyFile({
          path: '/other.bib',
          entries: [
            new BibEntry({ key: 'vaswani2017', entryType: 'article', fields: { title: 'Attention Duplicate' } }),
            new BibEntry({ key: 'lecun2015', entryType: 'article', fields: { title: 'Deep learning nature' } }),
          ],
        });

        mockAggregator.collectBibFiles.mockResolvedValue([file1, file2]);

        const useCase = new SearchCitationKeysUseCase(mockAggregator);
        const results = await useCase.execute({ projectId: 'proj-1', query: 'deep' });

        expect(results).toHaveLength(2); // goodfellow2016 and lecun2015
        expect(results.map((r: BibEntry) => r.key.value)).toEqual(['goodfellow2016', 'lecun2015']);
      });

      it('should respect result limit parameter', async () => {
        const entries: BibEntry[] = [];
        for (let i = 0; i < 10; i++) {
          entries.push(new BibEntry({ key: `entry${i}`, entryType: 'misc', fields: { title: `Paper ${i}` } }));
        }
        const file = new BibliographyFile({ path: '/refs.bib', entries });
        mockAggregator.collectBibFiles.mockResolvedValue([file]);

        const useCase = new SearchCitationKeysUseCase(mockAggregator);
        const results = await useCase.execute({ projectId: 'p1', limit: 3 });
        expect(results).toHaveLength(3);
      });
    });

    describe('ResolveIdentifierToBibUseCase', () => {
      let mockResolver: any;

      beforeEach(() => {
        mockResolver = { resolve: jest.fn() };
      });

      it('should resolve DOI and append to target bibliography file', async () => {
        const dummyEntry = new BibEntry({
          key: 'resolvedDoi',
          entryType: 'article',
          fields: { title: 'Resolved Paper', year: '2023' },
        });

        mockResolver.resolve.mockResolvedValue(dummyEntry);
        mockAggregator.appendEntryToBib.mockResolvedValue('/references.bib');

        const useCase = new ResolveIdentifierToBibUseCase(mockResolver, mockAggregator);
        const result = await useCase.execute({
          projectId: 'p1',
          identifier: '10.1145/12345',
        });

        expect(result.entry.key.value).toBe('resolvedDoi');
        expect(result.filePath).toBe('/references.bib');
        expect(result.identifierType).toBe('doi');
      });

      it('should throw IdentifierNotFoundException on unknown identifier or null resolution', async () => {
        const useCase = new ResolveIdentifierToBibUseCase(mockResolver, mockAggregator);

        await expect(
          useCase.execute({ projectId: 'p1', identifier: 'invalid-identifier' })
        ).rejects.toThrow(IdentifierNotFoundException);

        mockResolver.resolve.mockResolvedValue(null);
        await expect(
          useCase.execute({ projectId: 'p1', identifier: '10.1145/notfound' })
        ).rejects.toThrow(IdentifierNotFoundException);
      });
    });

    describe('ValidateProjectBibtexUseCase', () => {
      it('should report valid when no duplicate keys and metadata is populated', async () => {
        const file = new BibliographyFile({
          path: '/refs.bib',
          entries: [
            new BibEntry({
              key: 'k1',
              entryType: 'article',
              fields: { title: 'Title One', author: 'Author One', year: '2020' },
            }),
          ],
        });
        mockAggregator.collectBibFiles.mockResolvedValue([file]);

        const useCase = new ValidateProjectBibtexUseCase(mockAggregator);
        const report = await useCase.execute('p1');

        expect(report.valid).toBe(true);
        expect(report.totalEntries).toBe(1);
        expect(report.duplicateKeys).toHaveLength(0);
      });

      it('should detect duplicate keys across files and generate warnings', async () => {
        const file1 = new BibliographyFile({
          path: '/f1.bib',
          entries: [
            new BibEntry({
              key: 'dup',
              entryType: 'article',
              fields: { title: 'T1', author: 'A1', year: '2021' },
            }),
          ],
        });

        const file2 = new BibliographyFile({
          path: '/f2.bib',
          entries: [
            new BibEntry({
              key: 'dup',
              entryType: 'book',
              fields: {}, // missing title, author, year
            }),
          ],
        });

        mockAggregator.collectBibFiles.mockResolvedValue([file1, file2]);

        const useCase = new ValidateProjectBibtexUseCase(mockAggregator);
        const report = await useCase.execute('p1');

        expect(report.valid).toBe(false);
        expect(report.duplicateKeys).toContain('dup');
        expect(report.warnings.length).toBeGreaterThan(0);
      });
    });

    describe('SyncLibraryCollectionUseCase', () => {
      let mockLibrarySync: any;
      let parser: RegexAstBibtexParser;

      beforeEach(() => {
        mockLibrarySync = {
          listCollections: jest.fn(),
          fetchCollectionBibtex: jest.fn(),
        };
        parser = new RegexAstBibtexParser();
      });

      it('should fetch raw BibTeX from library and append each entry', async () => {
        mockLibrarySync.fetchCollectionBibtex.mockResolvedValue(`
          @article{entry1, title={Paper 1}}
          @book{entry2, title={Book 2}}
        `);
        mockAggregator.appendEntryToBib.mockResolvedValue('/references.bib');

        const useCase = new SyncLibraryCollectionUseCase(mockLibrarySync, parser, mockAggregator);
        const res = await useCase.execute({
          projectId: 'p1',
          userId: 'u1',
          collectionId: 'coll-1',
        });

        expect(res.collectionId).toBe('coll-1');
        expect(res.syncedCount).toBe(2);
        expect(mockAggregator.appendEntryToBib).toHaveBeenCalledTimes(2);
      });

      it('should list collections for user', async () => {
        mockLibrarySync.listCollections.mockResolvedValue([{ id: 'c1', name: 'Zotero Folder', itemCount: 5 }]);

        const useCase = new SyncLibraryCollectionUseCase(mockLibrarySync, parser, mockAggregator);
        const colls = await useCase.listUserCollections('u1');
        expect(colls).toHaveLength(1);
        expect(colls[0].id).toBe('c1');
      });
    });
  });

  // =========================================================================
  // 4. SERVICE & CONTROLLER INTEGRATION LAYER
  // =========================================================================
  describe('Service & Controller Integration Layer', () => {
    let service: CitationsService;
    let controller: CitationsController;
    let utilityController: CitationsUtilityController;

    let mockSearchUseCase: any;
    let mockResolveUseCase: any;
    let mockValidateUseCase: any;
    let mockSyncUseCase: any;
    let parser: RegexAstBibtexParser;

    beforeEach(() => {
      parser = new RegexAstBibtexParser();
      mockSearchUseCase = { execute: jest.fn() };
      mockResolveUseCase = { execute: jest.fn() };
      mockValidateUseCase = { execute: jest.fn() };
      mockSyncUseCase = {
        execute: jest.fn(),
        listUserCollections: jest.fn(),
      };

      service = new CitationsService(
        mockSearchUseCase,
        mockResolveUseCase,
        mockValidateUseCase,
        mockSyncUseCase,
        parser
      );

      controller = new CitationsController(service);
      utilityController = new CitationsUtilityController(service);
    });

    describe('CitationsController', () => {
      it('GET /citations/search should return mapped BibEntryDto array', async () => {
        const dummyEntry = new BibEntry({
          key: 'vaswani2017',
          entryType: 'article',
          fields: { title: 'Attention', year: '2017' },
        });
        mockSearchUseCase.execute.mockResolvedValue([dummyEntry]);

        const result = await controller.searchCitationKeys('p1', { query: 'attention' });
        expect(result).toHaveLength(1);
        expect(result[0].key).toBe('vaswani2017');
      });

      it('POST /citations/resolve should return resolved entry or throw 404', async () => {
        const dummyEntry = new BibEntry({
          key: 'doiKey',
          entryType: 'article',
          fields: { title: 'DOI Title' },
        });
        mockResolveUseCase.execute.mockResolvedValue({
          entry: dummyEntry,
          filePath: '/references.bib',
          identifierType: 'doi',
        });

        const res = await controller.resolveIdentifier('p1', { identifier: '10.1145/123' });
        expect(res.entry.key).toBe('doiKey');
        expect(res.filePath).toBe('/references.bib');

        // Test not found exception
        mockResolveUseCase.execute.mockRejectedValue(new IdentifierNotFoundException('10.9999/none'));
        await expect(
          controller.resolveIdentifier('p1', { identifier: '10.9999/none' })
        ).rejects.toThrow(NotFoundException);
      });

      it('GET /citations/validate should return validation summary', async () => {
        mockValidateUseCase.execute.mockResolvedValue({
          valid: true,
          totalFiles: 1,
          totalEntries: 5,
          duplicateKeys: [],
          warnings: [],
        });

        const res = await controller.validateBibtex('p1');
        expect(res.valid).toBe(true);
        expect(res.totalEntries).toBe(5);
      });

      it('POST /citations/sync-library should sync with user context', async () => {
        mockSyncUseCase.execute.mockResolvedValue({
          collectionId: 'c1',
          syncedCount: 3,
          filePath: '/references.bib',
        });

        const req = { user: { id: 'user-42' } };
        const res = await controller.syncLibrary('p1', { collectionId: 'c1' }, req);
        expect(res.collectionId).toBe('c1');
        expect(mockSyncUseCase.execute).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-42' })
        );
      });
    });

    describe('CitationsUtilityController', () => {
      it('GET /citations/library-collections should list user collections', async () => {
        mockSyncUseCase.listUserCollections.mockResolvedValue([
          { id: 'c1', name: 'Col 1', itemCount: 10 },
        ]);

        const req = { headers: { 'x-user-id': 'u-custom' } };
        const list = await utilityController.listLibraryCollections(req);
        expect(list).toHaveLength(1);
        expect(mockSyncUseCase.listUserCollections).toHaveBeenCalledWith('u-custom');
      });

      it('POST /citations/parse-raw should parse BibTeX in memory', () => {
        const raw = `@article{rawKey, title={Raw Title}}`;
        const res = utilityController.parseRawBibtex({ rawBibtex: raw });
        expect(res).toHaveLength(1);
        expect(res[0].key).toBe('rawKey');
      });
    });
  });
});
