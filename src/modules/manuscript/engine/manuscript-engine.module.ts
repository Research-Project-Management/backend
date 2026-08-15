import { Module } from '@nestjs/common';
import { ManuscriptEngineController } from './manuscript-engine.controller';
import { ManuscriptEngineService } from './manuscript-engine.service';
import { LatexModule } from '../latex/latex.module';
import { PageModule } from '../page/page.module';
import { VersionModule } from '../version/version.module';

@Module({
  imports: [LatexModule, PageModule, VersionModule],
  controllers: [ManuscriptEngineController],
  providers: [ManuscriptEngineService],
  exports: [ManuscriptEngineService],
})
export class ManuscriptEngineModule {}
