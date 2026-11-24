/**
 * citations/citations.module.ts
 * NestJS Module for Manuscripts Citations & Bibliography subsystem.
 */

import { Module } from '@nestjs/common';
import { StructureModule } from '@/modules/pages/structure/structure.module';
import { DocstoreModule } from '@/modules/pages/docstore/docstore.module';
import { PagesCoreModule } from '@/modules/pages/core';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';
import { LibraryModule } from '@/modules/library';

import { CitationsController } from './citations.controller';
import { CitationsService } from './citations.service';
import { CitationsRepository } from './citations.repository';
import { BibtexParser, IdentifierResolver } from './domain';

@Module({
  imports: [
    PagesCoreModule,
    StructureModule,
    DocstoreModule,
    IntegrationsModule,
    LibraryModule,
  ],
  controllers: [CitationsController],
  providers: [
    CitationsRepository,
    CitationsService,
    BibtexParser,
    IdentifierResolver,
  ],
  exports: [
    CitationsService,
    CitationsRepository,
    BibtexParser,
    IdentifierResolver,
  ],
})
export class CitationsModule {}
