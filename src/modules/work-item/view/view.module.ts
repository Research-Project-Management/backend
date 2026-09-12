import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { CoreModule } from '../core/core.module';
import { ViewController } from './view.controller';
import { ViewService } from './view.service';
import { ViewRepository } from './view.repository';

@Module({
  imports: [PrismaModule, forwardRef(() => CoreModule)],
  controllers: [ViewController],
  providers: [ViewService, ViewRepository],
  exports: [ViewService, ViewRepository],
})
export class ViewModule {}
