import { Module } from '@nestjs/common';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { BibtexFormatter } from './formatters/bibtex.formatter';
import { DoiResolver } from './resolvers/doi.resolver';
import { PaperModule } from '../paper/paper.module';

@Module({
  imports: [PaperModule],
  controllers: [ReferenceController],
  providers: [ReferenceService, BibtexFormatter, DoiResolver],
  exports: [ReferenceService, BibtexFormatter, DoiResolver],
})
export class ReferenceModule {}
