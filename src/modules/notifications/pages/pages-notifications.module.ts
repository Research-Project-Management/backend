import { Module } from '@nestjs/common';
import { MENTION_PARSER_PORT } from '../core/ports/mention-parser.port';
import { RegexMentionParserAdapter } from '../core/adapters/parser/regex-mention-parser.adapter';
import { ParseAndNotifyMentionsUseCase } from '../core/use-cases/parse-and-notify-mentions.use-case';
import { PagesNotificationsService } from './pages-notifications.service';

@Module({
  providers: [
    {
      provide: MENTION_PARSER_PORT,
      useClass: RegexMentionParserAdapter,
    },
    RegexMentionParserAdapter,
    ParseAndNotifyMentionsUseCase,
    PagesNotificationsService,
  ],
  exports: [
    MENTION_PARSER_PORT,
    RegexMentionParserAdapter,
    ParseAndNotifyMentionsUseCase,
    PagesNotificationsService,
  ],
})
export class PagesNotificationsModule {}
export { PagesNotificationsModule as ManuscriptsNotificationsModule };
