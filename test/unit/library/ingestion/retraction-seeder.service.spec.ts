import {
  RetractionSeederService,
  parseRfc4180Csv,
  cleanRetractionReason,
  parseRetractionNature,
} from '@/modules/library/ingestion/services/retraction-seeder.service';
import { RetractionRepository } from '@/modules/library/ingestion/repositories/retraction.repository';
import { RetractionDatabaseService } from '@/modules/library/ingestion/services/retraction-database.service';

describe('RetractionSeederService & RFC-4180 CSV Parser', () => {
  describe('parseRfc4180Csv', () => {
    it('should parse standard CSV headers and rows correctly', () => {
      const csv = `Record ID,Title,OriginalPaperDOI,RetractionNature
1,Paper A,10.1000/1,Retraction
2,Paper B,10.1000/2,Correction`;

      const parsed = parseRfc4180Csv(csv);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({
        'Record ID': '1',
        Title: 'Paper A',
        OriginalPaperDOI: '10.1000/1',
        RetractionNature: 'Retraction',
      });
      expect(parsed[1]['OriginalPaperDOI']).toBe('10.1000/2');
    });

    it('should parse quoted fields containing commas and escaped quotes', () => {
      const csv = `Record ID,Title,OriginalPaperDOI,Reason
100,"Clinical study on ""X"", Part 1",10.1016/sample,"+Falsification of Data;+Plagiarism"`;

      const parsed = parseRfc4180Csv(csv);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].Title).toBe('Clinical study on "X", Part 1');
      expect(parsed[0].Reason).toBe('+Falsification of Data;+Plagiarism');
    });

    it('should handle multiline content within quoted fields without splitting rows', () => {
      const csv = `Record ID,Title,OriginalPaperDOI,Notes
200,Multiline paper,10.1000/multi,"This note spans
multiple lines
cleanly"`;

      const parsed = parseRfc4180Csv(csv);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].Notes).toBe('This note spans\nmultiple lines\ncleanly');
    });
  });

  describe('cleanRetractionReason', () => {
    it('should strip leading plus signs and format semicolon list', () => {
      const raw = '+Falsification/Fabrication of Data;+Plagiarism; +Fake Peer Review';
      expect(cleanRetractionReason(raw)).toBe(
        'Falsification/Fabrication of Data; Plagiarism; Fake Peer Review',
      );
    });

    it('should return empty string for falsy input', () => {
      expect(cleanRetractionReason(undefined)).toBe('');
      expect(cleanRetractionReason('')).toBe('');
    });
  });

  describe('parseRetractionNature', () => {
    it('should identify full retraction', () => {
      expect(parseRetractionNature('Retraction')).toEqual({
        nature: 'retraction',
        isRetracted: true,
      });
    });

    it('should identify expression of concern', () => {
      expect(parseRetractionNature('Expression of Concern')).toEqual({
        nature: 'expression_of_concern',
        isRetracted: true,
      });
    });

    it('should identify correction/erratum', () => {
      expect(parseRetractionNature('Correction')).toEqual({
        nature: 'correction',
        isRetracted: true,
      });
    });

    it('should mark reinstatement as not retracted', () => {
      expect(parseRetractionNature('Reinstatement')).toEqual({
        nature: 'reinstatement',
        isRetracted: false,
      });
    });
  });

  describe('RetractionSeederService.seedFromCsv', () => {
    let seeder: RetractionSeederService;
    let mockRepo: Partial<RetractionRepository>;
    let mockDb: Partial<RetractionDatabaseService>;

    beforeEach(() => {
      mockRepo = {
        bulkCreateRetractions: jest.fn().mockImplementation(async (batch) => batch.length),
      };
      mockDb = {
        warmMemoryIndex: jest.fn().mockResolvedValue(undefined),
        addRetractionToBloom: jest.fn(),
      };

      seeder = new RetractionSeederService(
        mockRepo as RetractionRepository,
        mockDb as RetractionDatabaseService,
      );
    });

    it('should parse Crossref CSV and bulk-insert normalized records', async () => {
      const sampleCsv = `Record ID,Title,Journal,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,RetractionDOI,RetractionDate
1,"Fabricated Trial",Nature,10.1038/nature12345,12345678,Retraction,"+Falsification of Data;+Plagiarism",10.1038/nature.retraction,2023-04-15
2,"Concerned Study",Lancet,10.1016/lancet.67890,0,Expression of Concern,+Investigation Pending,unavailable,2024-01-10
3,"Skipped Item",Book,unavailable,0,Retraction,+Error,unavailable,2020-01-01`;

      const result = await seeder.seedFromCsv(sampleCsv, { chunkSize: 10 });

      expect(result.totalRows).toBe(3);
      expect(result.validRecords).toBe(2); // Row 3 has unavailable DOI
      expect(result.inserted).toBe(2);
      expect(mockRepo.bulkCreateRetractions).toHaveBeenCalledTimes(1);

      const insertedBatch = (mockRepo.bulkCreateRetractions as jest.Mock).mock.calls[0][0];
      expect(insertedBatch).toHaveLength(2);

      expect(insertedBatch[0]).toEqual(
        expect.objectContaining({
          doi: '10.1038/nature12345',
          pmid: '12345678',
          title: 'Fabricated Trial',
          journal: 'Nature',
          nature: 'retraction',
          isRetracted: true,
          reason: 'Falsification of Data; Plagiarism',
          noticeUrl: 'https://doi.org/10.1038/nature.retraction',
          source: 'retraction_watch',
        }),
      );

      expect(insertedBatch[1]).toEqual(
        expect.objectContaining({
          doi: '10.1016/lancet.67890',
          pmid: null, // '0' is mapped to null
          nature: 'expression_of_concern',
          isRetracted: true,
          noticeUrl: null, // 'unavailable' is mapped to null
        }),
      );

      expect(mockDb.warmMemoryIndex).toHaveBeenCalled();
    });

    it('should deduplicate repeated DOIs within the same CSV dump', async () => {
      const sampleCsv = `Record ID,Title,OriginalPaperDOI,RetractionNature
1,Paper 1,10.1000/duplicate,Retraction
2,Paper 2 Duplicate,10.1000/duplicate,Retraction`;

      const result = await seeder.seedFromCsv(sampleCsv);
      expect(result.validRecords).toBe(1);
      expect(result.inserted).toBe(1);
    });
  });
});
