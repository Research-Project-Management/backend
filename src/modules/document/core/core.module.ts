import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { CoreRepository } from './core.repository';
import { DocumentFacade, DOCUMENT_FACADE } from '../document.facade';
import { NodeModule } from '../node/node.module';

@Module({
  imports: [NodeModule],
  controllers: [CoreController],
  providers: [
    CoreService,
    CoreRepository,
    DocumentFacade,
    {
      provide: DOCUMENT_FACADE,
      useClass: DocumentFacade,
    },
  ],
  exports: [CoreService, CoreRepository, DocumentFacade, DOCUMENT_FACADE],
})
export class CoreModule {}

export const PageModule = CoreModule;
export type PageModule = CoreModule;
