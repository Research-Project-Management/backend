import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { CoreModule } from '../core/core.module';
import { TemplateController } from './template.controller';
import { TemplateRepository } from './template.repository';
import { TemplateService } from './template.service';

@Module({
  imports: [PrismaModule, forwardRef(() => CoreModule)],
  controllers: [TemplateController],
  providers: [TemplateRepository, TemplateService],
  exports: [TemplateService, TemplateRepository],
})
export class TemplateModule {}
