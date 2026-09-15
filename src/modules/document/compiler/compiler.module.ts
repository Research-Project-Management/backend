import { Module } from '@nestjs/common';
import { CompilerController } from './compiler.controller';
import { CompilerService } from './compiler.service';
import { CoreModule as DocumentCoreModule } from '../core/core.module';
import { HistoryModule } from '../history/history.module';
import { LibraryModule } from '../../library/library.module';
import { AssetModule } from '../asset/asset.module';
import { CoreModule as AppCoreModule } from '@/core/core.module';

@Module({
  imports: [
    DocumentCoreModule,
    HistoryModule,
    LibraryModule,
    AssetModule,
    AppCoreModule,
  ],
  controllers: [CompilerController],
  providers: [CompilerService],
  exports: [CompilerService],
})
export class CompilerModule {}

export const LatexModule = CompilerModule;
export type LatexModule = CompilerModule;
export const EngineModule = CompilerModule;
export type EngineModule = CompilerModule;
