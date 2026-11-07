import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { FilestoreModule } from '@/modules/pages/filestore/filestore.module';
import { ExportImportModule } from '@/modules/pages/export-import/export-import.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { IntegrationsRepository } from './integrations.repository';
import { ZoteroProvider } from './providers/zotero.provider';
import { MendeleyProvider } from './providers/mendeley.provider';
import { GithubProvider } from './providers/github.provider';

import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { StructureModule } from '@/modules/pages/structure/structure.module';

@Module({
  imports: [
    PrismaModule,
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
  exports: [
    IntegrationsService,
    IntegrationsRepository,
    ZoteroProvider,
    MendeleyProvider,
  ],
})
export class IntegrationsModule {}
