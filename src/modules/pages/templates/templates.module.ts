import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';

// Controllers & Services
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';
import { TemplatesRepository } from './templates.repository';

@Module({
  imports: [PrismaModule, StructureModule, DocstoreModule],
  controllers: [TemplatesController],
  providers: [TemplatesRepository, TemplatesService],
  exports: [TemplatesService, TemplatesRepository],
})
export class TemplatesModule {}
