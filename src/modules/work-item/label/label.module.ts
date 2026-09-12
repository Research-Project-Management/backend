import { Module } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { LabelController } from './label.controller';
import { LabelService } from './label.service';
import { LabelRepository } from './label.repository';

@Module({
  imports: [PrismaModule],
  controllers: [LabelController],
  providers: [LabelService, LabelRepository],
  exports: [LabelService],
})
export class LabelModule {}
