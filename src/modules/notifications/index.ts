export * from './notifications.module';
export * from './notifications.service';
export * from './notifications.controller';
export * from './dto/notification.dto';

// Manuscripts Submodule
export * from './manuscripts';

// Projects Submodule
export * from './projects';

// Core Domain
export * from './core/domain/entities/notification.entity';
export * from './core/domain/value-objects/notification-type.vo';
export * from './core/domain/exceptions/notification-not-found.exception';
export * from './core/domain/exceptions/invalid-notification.exception';

// Core Ports
export * from './core/ports/notification-repository.port';
export * from './core/ports/realtime-notifier.port';

// Core Adapters
export * from './core/adapters/storage/prisma-notification.adapter';
export * from './core/adapters/storage/in-memory-notification.adapter';
export * from './core/adapters/realtime/event-realtime-notifier.adapter';

// Core Use Cases
export * from './core/use-cases/create-notification.use-case';
export * from './core/use-cases/get-user-notifications.use-case';
export * from './core/use-cases/get-unread-count.use-case';
export * from './core/use-cases/mark-notification-read.use-case';
export * from './core/use-cases/mark-all-read.use-case';
export * from './core/use-cases/delete-notification.use-case';
