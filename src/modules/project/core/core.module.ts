import { Module } from '@nestjs/common';
import { CoreController } from './core.controller';
import { CoreService } from './core.service';
import { CoreRepository } from './core.repository';
import { FavoriteModule } from '../favorite/favorite.module';
import { LabelModule } from '../label/label.module';

@Module({
  imports: [FavoriteModule, LabelModule],
  controllers: [CoreController],
  providers: [CoreService, CoreRepository],
  exports: [CoreService, CoreRepository],
})
export class CoreModule {}
