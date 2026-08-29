import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesRepository } from './notes.repository';
import { CoreModule } from '../../../core/core.module';
import { SyncModule } from '../sync/sync.module';

@Module({
  imports: [CoreModule, SyncModule],
  controllers: [NotesController],
  providers: [NotesRepository, NotesService],
  exports: [NotesRepository, NotesService],
})
export class NotesModule {}
