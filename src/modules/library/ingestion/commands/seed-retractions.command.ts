import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { EntityNotFoundException } from '@/modules/library/core';
import {
  RetractionSeederService,
  RetractionSeedResult,
} from '../services/retraction-seeder.service';

export interface SeedRetractionsCommandOptions {
  filePath?: string;
  url?: string;
  chunkSize?: number;
}

@Injectable()
export class SeedRetractionsCommand {
  private readonly logger = new Logger(SeedRetractionsCommand.name);

  constructor(private readonly seeder: RetractionSeederService) {}

  async execute(options?: SeedRetractionsCommandOptions): Promise<RetractionSeedResult> {
    if (options?.filePath) {
      const resolvedPath = path.resolve(process.cwd(), options.filePath);
      this.logger.log(`Executing Retraction Seeder from local file: ${resolvedPath}`);
      if (!fs.existsSync(resolvedPath)) {
        throw new EntityNotFoundException(`Retraction seed CSV file not found at: ${resolvedPath}`);
      }
      const content = fs.readFileSync(resolvedPath, 'utf8');
      return this.seeder.seedFromCsv(content, { chunkSize: options.chunkSize });
    }

    if (options?.url) {
      this.logger.log(`Executing Retraction Seeder from custom URL: ${options.url}`);
      return this.seeder.seedFromGitlab(options.url);
    }

    this.logger.log('Executing Retraction Seeder from official Crossref GitLab repository');
    return this.seeder.seedFromGitlab();
  }
}
