import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { PagesCoreModule } from '@/modules/pages/core';
import { DocstoreModule } from '@/modules/pages/docstore';
import { ExportImportModule } from '@/modules/pages/export-import';
import { FilestoreModule } from '@/modules/pages/filestore';
import { StructureModule } from '@/modules/pages/structure';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { IntegrationsRepository } from './integrations.repository';
import { ZoteroProvider } from './providers/zotero.provider';
import { MendeleyProvider } from './providers/mendeley.provider';
import { GithubProvider } from './providers/github.provider';

@Module({
  imports: [
    PrismaModule,
    PagesCoreModule,
    FilestoreModule,
    ExportImportModule,
    DocstoreModule,
    StructureModule,
  ],
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
