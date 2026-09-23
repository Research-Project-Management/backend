import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { StructureModule } from '../structure/structure.module';
import { DocstoreModule } from '../docstore/docstore.module';

// Controllers
import {
  TemplatesController,
  OverleafTemplatesParityController,
} from './templates.controller';
import { TemplatesService } from './templates.service';

// Ports
import { TEMPLATE_REPOSITORY_PORT } from './core/ports/template-repository.port';
import { PROJECT_INSTANTIATOR_PORT } from './core/ports/project-instantiator.port';

// Adapters
import { PrismaTemplateAdapter } from './core/adapters/storage/prisma-template.adapter';
import { InMemoryTemplateAdapter } from './core/adapters/storage/in-memory-template.adapter';
import { ManuscriptInstantiatorAdapter } from './core/adapters/external/manuscript-instantiator.adapter';

// Use Cases
import { ListTemplatesUseCase } from './core/use-cases/list-templates.use-case';
import { GetTemplateByIdUseCase } from './core/use-cases/get-template-by-id.use-case';
import { SearchTemplatesUseCase } from './core/use-cases/search-templates.use-case';
import { InstantiateTemplateUseCase } from './core/use-cases/instantiate-template.use-case';
import { CreateCustomTemplateUseCase } from './core/use-cases/create-custom-template.use-case';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => StructureModule),
    forwardRef(() => DocstoreModule),
  ],
  controllers: [
    TemplatesController,
    OverleafTemplatesParityController,
  ],
  providers: [
    // Ports & Adapters
    {
      provide: TEMPLATE_REPOSITORY_PORT,
      useClass: PrismaTemplateAdapter,
    },
    {
      provide: PROJECT_INSTANTIATOR_PORT,
      useClass: ManuscriptInstantiatorAdapter,
    },
    PrismaTemplateAdapter,
    InMemoryTemplateAdapter,
    ManuscriptInstantiatorAdapter,

    // Use Cases
    ListTemplatesUseCase,
    GetTemplateByIdUseCase,
    SearchTemplatesUseCase,
    InstantiateTemplateUseCase,
    CreateCustomTemplateUseCase,

    // Facade Service
    TemplatesService,
  ],
  exports: [
    TemplatesService,
    TEMPLATE_REPOSITORY_PORT,
    PROJECT_INSTANTIATOR_PORT,
    ListTemplatesUseCase,
    GetTemplateByIdUseCase,
    SearchTemplatesUseCase,
    InstantiateTemplateUseCase,
    CreateCustomTemplateUseCase,
  ],
})
export class TemplatesModule {}
