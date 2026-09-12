import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { CoreModule } from '../core/core.module';
import { DraftController } from './draft.controller';
import { DraftRepository } from './draft.repository';
import { DraftService } from './draft.service';

@Module({
  imports: [PrismaModule, forwardRef(() => CoreModule)],
  controllers: [DraftController],
  providers: [DraftRepository, DraftService],
  exports: [DraftService, DraftRepository],
})
export class DraftModule {}
