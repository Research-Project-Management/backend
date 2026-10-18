import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';

// Controllers & Services
import {
  TemplatesController,
  OverleafTemplatesParityController,
} from './templates.controller';
import { TemplatesService } from './templates.service';
import {
  TemplatesRepository,
  InMemoryTemplateAdapter,
} from './templates.repository';
import { TEMPLATE_REPOSITORY_PORT, PROJECT_INSTANTIATOR_PORT } from './domain';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule],
  controllers: [TemplatesController, OverleafTemplatesParityController],
  providers: [
    InMemoryTemplateAdapter,
    TemplatesRepository,
    TemplatesService,
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
