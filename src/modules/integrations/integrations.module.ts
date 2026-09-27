import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { FilestoreModule } from '@/modules/manuscripts/filestore/filestore.module';
import { ExportImportModule } from '@/modules/manuscripts/export-import/export-import.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { IntegrationsRepository } from './integrations.repository';
import { ZoteroProvider } from './providers/zotero.provider';
import { MendeleyProvider } from './providers/mendeley.provider';
import { GithubProvider } from './providers/github.provider';

@Module({
  imports: [PrismaModule, FilestoreModule, ExportImportModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationsRepository,
    ZoteroProvider,
    MendeleyProvider,
    GithubProvider,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}

