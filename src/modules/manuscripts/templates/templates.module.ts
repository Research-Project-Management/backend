import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

// Controllers & Core Services
import {
  TemplatesController,
  OverleafTemplatesParityController,
} from './templates.controller';
import { TemplatesService } from './templates.service';
import { TemplatesRepository } from './templates.repository';

// Ports & Adapters
import { TEMPLATE_REPOSITORY_PORT } from './core/ports/template-repository.port';
import { PROJECT_INSTANTIATOR_PORT } from './core/ports/project-instantiator.port';
import { InMemoryTemplateAdapter } from './core/adapters/storage/in-memory-template.adapter';
import { ManuscriptInstantiatorAdapter } from './core/adapters/external/manuscript-instantiator.adapter';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule],
  controllers: [TemplatesController, OverleafTemplatesParityController],
  providers: [
    InMemoryTemplateAdapter,
    TemplatesRepository,
    TemplatesService,
    ManuscriptInstantiatorAdapter,
    {
      provide: TEMPLATE_REPOSITORY_PORT,
      useExisting: TemplatesRepository,
    },
    {
      provide: PROJECT_INSTANTIATOR_PORT,
      useExisting: TemplatesRepository,
    },
  ],
  exports: [
    TemplatesService,
    TemplatesRepository,
    TEMPLATE_REPOSITORY_PORT,
    PROJECT_INSTANTIATOR_PORT,
  ],
})
export class TemplatesModule {}
