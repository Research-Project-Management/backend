import { Test, TestingModule } from '@nestjs/testing';
import { SeedRetractionsCommand } from '@/modules/library/ingestion/commands/seed-retractions.command';
import { RetractionSeederService } from '@/modules/library/ingestion/services/retraction-seeder.service';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('SeedRetractionsCommand', () => {
  let command: SeedRetractionsCommand;
  let mockSeeder: jest.Mocked<Partial<RetractionSeederService>>;
  let tempFilePath: string;

  beforeEach(async () => {
    mockSeeder = {
      seedFromCsv: jest.fn().mockResolvedValue({
        totalRows: 10,
        validRecords: 10,
        inserted: 10,
        durationMs: 50,
      }),
      seedFromGitlab: jest.fn().mockResolvedValue({
        totalRows: 100,
        validRecords: 100,
        inserted: 100,
        durationMs: 500,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeedRetractionsCommand,
        {
          provide: RetractionSeederService,
          useValue: mockSeeder,
        },
      ],
    }).compile();

    command = module.get<SeedRetractionsCommand>(SeedRetractionsCommand);

    tempFilePath = path.join(os.tmpdir(), `test-retraction-seed-${Date.now()}.csv`);
  });

  afterEach(() => {
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
  });

  it('should default to seeding from official Crossref Gitlab repository', async () => {
    const res = await command.execute();

    expect(mockSeeder.seedFromGitlab).toHaveBeenCalledWith();
    expect(res.inserted).toBe(100);
  });

  it('should seed from custom URL when specified', async () => {
    const customUrl = 'https://custom-mirror.org/retraction_watch.csv';
    const res = await command.execute({ url: customUrl });

    expect(mockSeeder.seedFromGitlab).toHaveBeenCalledWith(customUrl);
    expect(res.inserted).toBe(100);
  });

  it('should seed from local file when specified', async () => {
    const sampleCsv = 'OriginalPaperDOI,Title\n10.1000/1,Paper 1';
    fs.writeFileSync(tempFilePath, sampleCsv, 'utf8');

    const res = await command.execute({ filePath: tempFilePath, chunkSize: 50 });

    expect(mockSeeder.seedFromCsv).toHaveBeenCalledWith(sampleCsv, {
      chunkSize: 50,
    });
    expect(res.inserted).toBe(10);
  });

  it('should throw if specified local file does not exist', async () => {
    const nonExistentPath = path.join(os.tmpdir(), 'non-existent-retraction-file.csv');

    await expect(command.execute({ filePath: nonExistentPath })).rejects.toThrow(
      'Retraction seed CSV file not found',
    );
    expect(mockSeeder.seedFromCsv).not.toHaveBeenCalled();
  });
});
