import { Inject, Injectable } from '@nestjs/common';
import {
  INotificationRepositoryPort,
  NOTIFICATION_REPOSITORY_PORT,
} from '../ports/notification-repository.port';

@Injectable()
export class GetUnreadCountUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY_PORT)
    private readonly repository: INotificationRepositoryPort
  ) {}

  async execute(userId: string): Promise<number> {
    if (!userId || !userId.trim()) {
      return 0;
    }
    return this.repository.countUnread(userId);
  }
}
