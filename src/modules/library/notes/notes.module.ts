import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';
import { NotesRepository } from './notes.repository';
import { CoreModule } from '../../../core/core.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [CoreModule, OutboxModule],
  controllers: [NotesController],
  providers: [NotesRepository, NotesService],
  exports: [NotesService],
})
export class NotesModule {}
