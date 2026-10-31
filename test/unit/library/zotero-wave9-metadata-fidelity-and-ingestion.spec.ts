import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import {
  buildCommandCreateInput,
  resolveExtraPlainText,
  extractNonColumnExtraFields,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { PubMedProvider } from '@/modules/library/ingestion/providers/pubmed.provider';

describe('Wave 9 — Metadata Ingestion, Extraction & Persistence Completeness & Accuracy', () => {
  describe('1. BibtexParser & IdentifyStage.mapBibtexToRaw fidelity', () => {
    const parser = new BibtexParser();

    it('extracts thesis, techreport, incollection, and inproceedings venue fields & identifiers', () => {
      const bib = `
@phdthesis{smith2024thesis,
  title = {Quantum Computing Architecture: A Deep Dive},
  shorttitle = {Quantum Computing Architecture},
  author = {Smith, Jane and {World Health Organization}},
  school = {Massachusetts Institute of Technology},
  type = {Doctoral Dissertation},
  year = {2024},
  address = {Cambridge, MA},
  pagetotal = {245},
  urldate = {2025-01-15},
  pmid = {38123456},
  pmcid = {PMC10987654}
}

@techreport{doe2023report,
  title = {AI Safety Technical Report},
  author = {{OpenAI Alignment Team}},
  institution = {OpenAI},
  number = {TR-2023-09},
  type = {Technical Report},
  year = {2023}
}

@inproceedings{chen2024conf,
  title = {Attention in Graph Networks},
  author = {Chen, Wei},
  booktitle = {Proceedings of NeurIPS 2024},
  eventtitle = {38th Conference on Neural Information Processing Systems},
  venue = {Vancouver, Canada},
  year = {2024},
  pages = {101--115},
  journaltitle = {NeurIPS Proc.},
  shortjournal = {NeurIPS}
}
`;
      const entries = parser.parse(bib);
      expect(entries).toHaveLength(3);

      const thesis = entries[0];
      expect(thesis.itemType).toBe('thesis');
      expect(thesis.university).toBe('Massachusetts Institute of Technology');
      expect(thesis.thesisType).toBe('Doctoral Dissertation');
      expect(thesis.shortTitle).toBe('Quantum Computing Architecture');
      expect(thesis.numPages).toBe('245');
      expect(thesis.accessedAt).toBe('2025-01-15');
      expect(thesis.pmid).toBe('38123456');
      expect(thesis.pmcid).toBe('PMC10987654');
      expect(thesis.creators).toBeDefined();
      expect(thesis.creators).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            firstName: 'Jane',
            lastName: 'Smith',
            creatorType: 'author',
          }),
          expect.objectContaining({
            lastName: 'World Health Organization',
            fieldMode: 1,
            creatorType: 'author',
          }),
        ]),
      );

      const report = entries[1];
      expect(report.itemType).toBe('report');
      expect(report.institution).toBe('OpenAI');
      expect(report.reportNumber).toBe('TR-2023-09');
      expect(report.reportType).toBe('Technical Report');
      expect(report.creators?.[0]).toMatchObject({
        lastName: 'OpenAI Alignment Team',
        fieldMode: 1,
      });

      const conf = entries[2];
      expect(conf.itemType).toBe('conferencePaper');
      expect(conf.proceedingsTitle).toBe('Proceedings of NeurIPS 2024');
      expect(conf.conferenceName).toBe(
        '38th Conference on Neural Information Processing Systems',
      );
      expect(conf.eventPlace).toBe('Vancouver, Canada');
      expect(conf.journalAbbr).toBe('NeurIPS');

      // Verify IdentifyStage.mapBibtexToRaw forwards all fields
      const stage = new IdentifyStage(
        {} as never,
        parser,
        new RisParser(),
        new NormalizationPolicy(),
      );
      const mapFn = (
        stage as unknown as {
          mapBibtexToRaw: (item: unknown) => Record<string, unknown>;
        }
      ).mapBibtexToRaw.bind(stage);

      const mappedThesis = mapFn(thesis);
      expect(mappedThesis.university).toBe(
        'Massachusetts Institute of Technology',
      );
      expect(mappedThesis.thesisType).toBe('Doctoral Dissertation');
      expect(mappedThesis.pmid).toBe('38123456');
      expect(mappedThesis.pmcid).toBe('PMC10987654');
      expect(mappedThesis.shortTitle).toBe('Quantum Computing Architecture');
      expect(mappedThesis.numPages).toBe('245');
      expect(mappedThesis.accessedAt).toBe('2025-01-15');
    });
  });

  describe('2. RisParser page range, identifiers & type-specific mapping', () => {
    const parser = new RisParser();

    it('merges SP/EP page ranges, extracts PMID/PMCID/arXiv, and maps THES/RPRT/CONF fields', () => {
      const ris = [
        'TY  - THES',
        'TI  - Deep Learning for Protein Folding',
        'ST  - DL Protein Folding',
        'AU  - Jumper, John',
        'PB  - University of Cambridge',
        'M3  - PhD Thesis',
        'PY  - 2021',
        'Y2  - 2024/06/10',
        'SP  - 1',
        'EP  - 180',
        'AN  - PMID: 34265844',
        'C2  - PMC8371605',
        'N1  - arXiv:2107.01234',
        'ER  - ',
        '',
        'TY  - CONF',
        'TI  - Scalable Transformers',
        'AU  - Vaswani, Ashish',
        'T2  - Advances in Neural Information Processing Systems',
        'C3  - NeurIPS 2017',
        'JA  - Adv. Neural Inf. Process. Syst.',
        'SP  - 5998',
        'EP  - 6008',
        'ER  - ',
      ].join('\n');

      const items = parser.parse(ris);
      expect(items).toHaveLength(2);

      const thesis = items[0];
      expect(thesis.itemType).toBe('thesis');
      expect(thesis.pages).toBe('1-180');
      expect(thesis.university).toBe('University of Cambridge');
      expect(thesis.thesisType).toBe('PhD Thesis');
      expect(thesis.shortTitle).toBe('DL Protein Folding');
      expect(thesis.accessedAt).toBe('2024-06-10');
      expect(thesis.pmid).toBe('34265844');
      expect(thesis.pmcid).toBe('PMC8371605');
      expect(thesis.arxivId).toBe('2107.01234');

      const conf = items[1];
      expect(conf.itemType).toBe('conferencePaper');
      expect(conf.pages).toBe('5998-6008');
      expect(conf.proceedingsTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(conf.conferenceName).toBe('NeurIPS 2017');
      expect(conf.journalAbbr).toBe('Adv. Neural Inf. Process. Syst.');
    });
  });

  describe('3. CslParser full CSL 1.0.2 creator roles, corporate literal & dates', () => {
    const parser = new CslParser();

    it('preserves all CSL creator roles, literal corporate creators (fieldMode: 1), and full ISO dates', () => {
      const cslPayload = [
        {
          id: 'who2024',
          type: 'report',
          title: 'Global Health Observatory Report 2024',
          'title-short': 'Global Health 2024',
          author: [{ literal: 'World Health Organization' }],
          editor: [{ family: 'Chan', given: 'Margaret' }],
          translator: [{ family: 'Dubois', given: 'Jean' }],
          'collection-editor': [{ family: 'Muller', given: 'Hans' }],
          issued: { 'date-parts': [[2024, 5, 18]] },
          accessed: { 'date-parts': [[2024, 11, 2]] },
          publisher: 'WHO Press',
          'publisher-place': 'Geneva',
          number: 'WHO/2024/05',
          genre: 'Annual Technical Report',
          PMID: '39001122',
          PMCID: 'PMC11223344',
          'number-of-pages': 312,
        },
      ];

      const parsed = parser.parse(cslPayload);
      expect(parsed).toHaveLength(1);
      const entry = parsed[0];

      expect(entry.itemType).toBe('report');
      expect(entry.publicationDate).toBe('2024-05-18');
      expect(entry.accessedAt).toBe('2024-11-02');
      expect(entry.shortTitle).toBe('Global Health 2024');
      expect(entry.institution).toBe('WHO Press');
      expect(entry.reportNumber).toBe('WHO/2024/05');
      expect(entry.reportType).toBe('Annual Technical Report');
      expect(entry.pmid).toBe('39001122');
      expect(entry.pmcid).toBe('PMC11223344');
      expect(entry.numPages).toBe('312');

      expect(entry.creators).toEqual([
        {
          name: 'World Health Organization',
          fullName: 'World Health Organization',
          firstName: '',
          lastName: 'World Health Organization',
          creatorType: 'author',
          fieldMode: 1,
        },
        {
          name: 'Margaret Chan',
          fullName: 'Margaret Chan',
          firstName: 'Margaret',
          lastName: 'Chan',
          creatorType: 'editor',
        },
        {
          name: 'Jean Dubois',
          fullName: 'Jean Dubois',
          firstName: 'Jean',
          lastName: 'Dubois',
          creatorType: 'translator',
        },
        {
          name: 'Hans Muller',
          fullName: 'Hans Muller',
          firstName: 'Hans',
          lastName: 'Muller',
          creatorType: 'seriesEditor',
        },
      ]);
    });
  });

  describe('4. Corporate creator fieldMode: 1 & shortName preservation across NormalizationPolicy and CommitStage', () => {
    it('does not split corporate names containing "and" or commas when fieldMode === 1', () => {
      const policy = new NormalizationPolicy();
      const normalized = policy.normalize({
        title: 'National Academies Consensus Report',
        itemType: 'report',
        creators: [
          {
            creatorType: 'author',
            name: 'National Academy of Sciences, Engineering, and Medicine',
            fullName: 'National Academy of Sciences, Engineering, and Medicine',
            lastName: 'National Academy of Sciences, Engineering, and Medicine',
            fieldMode: 1,
            shortName: 'NASEM',
          },
        ],
      });

      expect(normalized.creators).toHaveLength(1);
      expect(normalized.creators?.[0]).toMatchObject({
        creatorType: 'author',
        lastName: 'National Academy of Sciences, Engineering, and Medicine',
        fieldMode: 1,
        shortName: 'NASEM',
      });
      expect(normalized.creators?.[0]?.firstName).toBeUndefined();

      // Verify CommitStage toItemData preserves fieldMode: 1 and shortName
      const finalPayload = toItemData(normalized);
      const finalCreators = finalPayload.creators as Array<
        Record<string, unknown>
      >;
      expect(finalCreators).toHaveLength(1);
      expect(finalCreators[0]).toMatchObject({
        creatorType: 'author',
        firstName: '',
        lastName: 'National Academy of Sciences, Engineering, and Medicine',
        fieldMode: 1,
        shortName: 'NASEM',
      });
    });
  });

  describe('5. ZoteroSchemaValidatorService & CommandPayloadBuilder extra plain-text hygiene', () => {
    const typesService = new TypesService();
    const validator = new ZoteroSchemaValidatorService(typesService);

    it('does not demote valid Zotero schema fields or telemetry objects into plain-text extra', async () => {
      const validated = validator.validateAndSanitizeItem('bookSection', {
        title: 'Chapter 1: Foundations',
        bookTitle: 'Handbook of AI',
        seriesNumber: '4',
        numPages: '350',
        shortTitle: 'Foundations',
        ingestionStatus: 'COMPLETED',
        verificationScore: 95,
        isVerified: true,
        fieldProvenance: { title: { source: 'crossref', confidence: 0.99 } },
      });

      expect(validated.demotedToExtra).toEqual({});
      // extra is only emitted when sent or when fields were demoted (avoids wiping it on PATCH).
      expect(validated.sanitizedItem.extra).toBeUndefined();
      expect(validated.sanitizedItem.bookTitle).toBe('Handbook of AI');

      // Also verify CommandPayloadBuilder does not dump extraFields into metadata.extra plain text
      const { createData } = buildCommandCreateInput(
        'user-1',
        {
          title: 'Chapter 1: Foundations',
          itemType: 'bookSection',
          bookTitle: 'Handbook of AI',
          seriesNumber: '4',
          extra: 'arXiv: 2401.00001',
          fieldProvenance: { title: { source: 'crossref' } },
          ingestionStatus: 'COMPLETED',
          verificationScore: 95,
        },
      );

      const meta = createData.metadata as Record<string, unknown>;
      expect(meta.extra).toBe('arXiv: 2401.00001');
      expect(String(meta.extra)).not.toContain('BookTitle:');
      expect(String(meta.extra)).not.toContain('[object Object]');
      expect(meta).toMatchObject({
        bookTitle: 'Handbook of AI',
        seriesNumber: '4',
      });
      // Transient telemetry keys should not pollute metadata JSONB
      expect(meta.ingestionStatus).toBeUndefined();
      expect(meta.verificationScore).toBeUndefined();
    });

    it('resolveExtraPlainText updates existing key lines without appending arbitrary JSONB keys', () => {
      const updated = resolveExtraPlainText(
        'PMID: 11111\nCustom Note Line',
        null,
        {
          pmid: '22222',
          bookTitle: 'Should Not Be Appended',
          fieldProvenance: { title: 'crossref' },
        },
      );
      expect(updated).toBe('PMID: 22222\nCustom Note Line');

      const extraFields = extractNonColumnExtraFields({
        title: 'Test',
        bookTitle: 'Handbook',
        ingestionStatus: 'COMPLETED',
        isSelfSufficient: true,
      });
      expect(extraFields).toEqual({ bookTitle: 'Handbook' });
    });
  });

  describe('6. ArxivProvider & PubMedProvider metadata completeness', () => {
    it('ArxivProvider maps arxiv:journal_ref into extraFields.journalRef and publicationTitle', () => {
      const provider = new ArxivProvider();
      const parseAtomXml = (
        provider as unknown as {
          parseAtomXml: (
            xml: string,
            cleanId: string,
          ) => { metadata: Record<string, unknown> };
        }
      ).parseAtomXml.bind(provider);

      const sampleXml = `
        <feed>
          <entry>
            <id>http://arxiv.org/abs/2305.12345v1</id>
            <published>2023-05-20T12:00:00Z</published>
            <title> Quantum Error Mitigation </title>
            <summary> Abstract text here. </summary>
            <author><name>Alice Bob</name></author>
            <arxiv:primary_category term="quant-ph"/>
            <arxiv:journal_ref>Nature Physics 19, 100-108 (2023)</arxiv:journal_ref>
          </entry>
        </feed>
      `;

      const res = parseAtomXml(sampleXml, '2305.12345');
      expect(res.metadata.publicationTitle).toBe(
        'Nature Physics 19, 100-108 (2023)',
      );
      expect(
        (res.metadata.extraFields as Record<string, unknown>).journalRef,
      ).toBe('Nature Physics 19, 100-108 (2023)');
    });

    it('PubMedProvider.transformCslPayload extracts shortTitle, language, publisher, and place', () => {
      const provider = new PubMedProvider();
      const transformCsl = (
        provider as unknown as {
          transformCslPayload: (
            data: Record<string, unknown>,
            id: string,
            isPmc: boolean,
          ) => { metadata: Record<string, unknown> };
        }
      ).transformCslPayload.bind(provider);

      const res = transformCsl(
        {
          title: 'CRISPR-Cas9 Genome Editing: Principles and Applications',
          'title-short': 'CRISPR-Cas9 Genome Editing',
          'container-title': 'Nature Reviews Genetics',
          'container-title-short': 'Nat Rev Genet',
          publisher: 'Springer Nature',
          'publisher-place': 'London',
          language: 'eng',
          PMID: '35000001',
          DOI: '10.1038/s41576-022-00001-x',
          issued: { 'date-parts': [[2022, 3, 15]] },
        },
        '35000001',
        false,
      );

      expect(res.metadata.shortTitle).toBe('CRISPR-Cas9 Genome Editing');
      expect(res.metadata.publisher).toBe('Springer Nature');
      expect(res.metadata.place).toBe('London');
      expect(res.metadata.language).toBe('eng');
      expect(res.metadata.publicationDate).toBe('2022-03-15');
    });
  });
});
