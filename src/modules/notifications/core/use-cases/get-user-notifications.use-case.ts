import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
  QueryNotificationsOptions,
} from '../ports/notification-repository.port';
import { NotificationEntity } from '../domain/entities/notification.entity';

@Injectable()
export class GetUserNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort
  ) {}

  async execute(
    userId: string,
    options?: QueryNotificationsOptions
  ): Promise<NotificationEntity[]> {
    if (!userId || !userId.trim()) {
      return [];
    }
    return this.repository.findByUser(userId, options);
  }
}
