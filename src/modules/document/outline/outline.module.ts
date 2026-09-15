import { Module } from '@nestjs/common';
import { OutlineController } from './outline.controller';
import { OutlineService } from './outline.service';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [AppCoreModule],
  controllers: [OutlineController],
  providers: [OutlineService],
  exports: [OutlineService],
})
export class OutlineModule {}
