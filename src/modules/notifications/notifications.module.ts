import { Module, Global } from '@nestjs/common';
import { PrismaModule } from '@/core';
import { RealtimeModule } from '@/modules/realtime/realtime.module';

// Submodules
import { ManuscriptsNotificationsModule } from './manuscripts/manuscripts-notifications.module';
import { ProjectsNotificationsModule } from './projects/projects-notifications.module';

// Controllers
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// Core Ports
import { NOTIFICATION_REPOSITORY_PORT } from './core/ports/notification-repository.port';
import { REALTIME_NOTIFIER_PORT } from './core/ports/realtime-notifier.port';

// Core Adapters
import { PrismaNotificationAdapter } from './core/adapters/storage/prisma-notification.adapter';
import { InMemoryNotificationAdapter } from './core/adapters/storage/in-memory-notification.adapter';
import { EventRealtimeNotifierAdapter } from './core/adapters/realtime/event-realtime-notifier.adapter';

// Core Use Cases
import { CreateNotificationUseCase } from './core/use-cases/create-notification.use-case';
import { GetUserNotificationsUseCase } from './core/use-cases/get-user-notifications.use-case';
import { GetUnreadCountUseCase } from './core/use-cases/get-unread-count.use-case';
import { MarkNotificationReadUseCase } from './core/use-cases/mark-notification-read.use-case';
import { MarkAllReadUseCase } from './core/use-cases/mark-all-read.use-case';
import { DeleteNotificationUseCase } from './core/use-cases/delete-notification.use-case';
import { ReviewNotificationBundlingUseCase } from './core/use-cases/review-notification-bundling.use-case';
import { ReviewBundleStorePort } from './core/ports/review-bundle-store.port';
import { PrismaReviewBundleStoreAdapter } from './core/adapters/storage/prisma-review-bundle-store.adapter';
import { ReviewBundleFlushScheduler } from './core/adapters/scheduling/review-bundle-flush.scheduler';

@Global()
@Module({
  imports: [
    PrismaModule,
    RealtimeModule,
    ManuscriptsNotificationsModule,
    ProjectsNotificationsModule,
  ],
  controllers: [NotificationsController],
  providers: [
    // Core Ports & Adapters
    {
      provide: NOTIFICATION_REPOSITORY_PORT,
      useClass: PrismaNotificationAdapter,
    },
    {
      provide: REALTIME_NOTIFIER_PORT,
      useClass: EventRealtimeNotifierAdapter,
    },
    PrismaNotificationAdapter,
    InMemoryNotificationAdapter,
    EventRealtimeNotifierAdapter,

    // Core Use Cases
    CreateNotificationUseCase,
    GetUserNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkNotificationReadUseCase,
    MarkAllReadUseCase,
    DeleteNotificationUseCase,
    ReviewNotificationBundlingUseCase,
    ReviewBundleFlushScheduler,
    {
      provide: ReviewBundleStorePort,
      useClass: PrismaReviewBundleStoreAdapter,
    },

    // Root Facade Service
    NotificationsService,
  ],
  exports: [
    NotificationsService,
    ManuscriptsNotificationsModule,
    ProjectsNotificationsModule,
    NOTIFICATION_REPOSITORY_PORT,
    REALTIME_NOTIFIER_PORT,
    CreateNotificationUseCase,
    GetUserNotificationsUseCase,
    GetUnreadCountUseCase,
    MarkNotificationReadUseCase,
    MarkAllReadUseCase,
    DeleteNotificationUseCase,
  ],
})
export class NotificationsModule {}
