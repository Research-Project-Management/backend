import { Module, forwardRef } from '@nestjs/common';
import { MENTION_PARSER_PORT } from './core/ports/mention-parser.port';
import { RegexMentionParserAdapter } from './core/adapters/regex-mention-parser.adapter';
import { ParseAndNotifyMentionsUseCase } from './core/use-cases/parse-and-notify-mentions.use-case';
import { ManuscriptsNotificationsService } from './manuscripts-notifications.service';
import { CreateNotificationUseCase } from '../core/use-cases/create-notification.use-case';
import { DeleteNotificationUseCase } from '../core/use-cases/delete-notification.use-case';

@Module({
  providers: [
    {
      provide: MENTION_PARSER_PORT,
      useClass: RegexMentionParserAdapter,
    },
    RegexMentionParserAdapter,
    ParseAndNotifyMentionsUseCase,
    ManuscriptsNotificationsService,
  ],
  exports: [
    MENTION_PARSER_PORT,
    RegexMentionParserAdapter,
    ParseAndNotifyMentionsUseCase,
    ManuscriptsNotificationsService,
  ],
})
export class ManuscriptsNotificationsModule {}
