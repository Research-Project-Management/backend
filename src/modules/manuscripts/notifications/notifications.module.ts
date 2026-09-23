import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@/core/database/prisma.module';
import { RealtimeModule } from '../realtime/realtime.module';

// Controllers
import {
  NotificationsController,
  OverleafNotificationsParityController,
} from './notifications.controller';
import { NotificationsService } from './notifications.service';

// Ports
import { NOTIFICATION_REPOSITORY_PORT } from './core/ports/notification-repository.port';
import { MENTION_PARSER_PORT } from './core/ports/mention-parser.port';
import { REALTIME_NOTIFIER_PORT } from './core/ports/realtime-notifier.port';

// Adapters
import { PrismaNotificationAdapter } from './core/adapters/storage/prisma-notification.adapter';
import { InMemoryNotificationAdapter } from './core/adapters/storage/in-memory-notification.adapter';
import { RegexMentionParserAdapter } from './core/adapters/parser/regex-mention-parser.adapter';
import { EventRealtimeNotifierAdapter } from './core/adapters/realtime/event-realtime-notifier.adapter';

// Use Cases
import { CreateNotificationUseCase } from './core/use-cases/create-notification.use-case';
import { GetUserNotificationsUseCase } from './core/use-cases/get-user-notifications.use-case';
import { GetUnreadCountUseCase } from './core/use-cases/get-unread-count.use-case';
import { MarkNotificationReadUseCase } from './core/use-cases/mark-notification-read.use-case';
import { MarkAllReadUseCase } from './core/use-cases/mark-all-read.use-case';
import { DeleteNotificationUseCase } from './core/use-cases/delete-notification.use-case';
import { ParseAndNotifyMentionsUseCase } from './core/use-cases/parse-and-notify-mentions.use-case';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => RealtimeModule),
  ],
  controllers: [
    NotificationsController,
    OverleafNotificationsParityController,
  ],
  providers: [
    // Ports & Adapters
    {
      provide: NOTIFICATION_REPOSITORY_PORT,
      useClass: PrismaNotificationAdapter,
    },
    {
      provide: MENTION_PARSER_PORT,
      useClass: RegexMentionParserAdapter,
    },
    {
      provide: REALTIME_NOTIFIER_PORT,
      useClass: EventRealtimeNotifierAdapter,
    },
    PrismaNotificationAdapter,
    InMemoryNotificationAdapter,
    RegexMentionParserAdapter,
    EventRealtimeNotifierAdapter,

    // Use Cases
    CreateNotificationUseCase,
    GetUserNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkNotificationReadUseCase,
    MarkAllReadUseCase,
    DeleteNotificationUseCase,
    ParseAndNotifyMentionsUseCase,

    // Facade Service
    NotificationsService,
  ],
  exports: [
    NotificationsService,
    NOTIFICATION_REPOSITORY_PORT,
    MENTION_PARSER_PORT,
    REALTIME_NOTIFIER_PORT,
    CreateNotificationUseCase,
    GetUserNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkNotificationReadUseCase,
    MarkAllReadUseCase,
    DeleteNotificationUseCase,
    ParseAndNotifyMentionsUseCase,
  ],
})
export class NotificationsModule {}
