/**
 * citations/citations.module.ts
 * NestJS Module for Manuscripts Citations & Bibliography subsystem.
 */

import { Module } from '@nestjs/common';
import { StructureModule } from '@/modules/manuscripts/structure/structure.module';
import { DocstoreModule } from '@/modules/manuscripts/docstore/docstore.module';
import { PrismaModule } from '@/core';
import { ManuscriptsCoreModule } from '@/modules/manuscripts/core';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';
import { LibraryModule } from '@/modules/library';

import {
  CitationsController,
  CitationsUtilityController,
} from './citations.controller';
import { CitationsService } from './citations.service';
import { CitationsRepository } from './citations.repository';
import { RegexAstBibtexParser, CrossrefArxivResolverAdapter } from './domain';

@Module({
  imports: [
    ManuscriptsCoreModule,
    StructureModule,
    DocstoreModule,
    PrismaModule,
    IntegrationsModule,
    LibraryModule,
  ],
  controllers: [CitationsController, CitationsUtilityController],
  providers: [
    CitationsRepository,
    CitationsService,
    RegexAstBibtexParser,
    CrossrefArxivResolverAdapter,
  ],
  exports: [
    CitationsService,
    CitationsRepository,
    RegexAstBibtexParser,
    CrossrefArxivResolverAdapter,
  ],
})
export class CitationsModule {}
