import { Module } from '@nestjs/common';
import { FavoriteController } from './favorite.controller';
import { FavoriteService } from './favorite.service';
import { FavoriteRepository } from './favorite.repository';

@Module({
  controllers: [FavoriteController],
  providers: [FavoriteService, FavoriteRepository],
  exports: [FavoriteService, FavoriteRepository],
})
export class FavoriteModule {}
