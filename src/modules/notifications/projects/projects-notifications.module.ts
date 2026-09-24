import { Module } from '@nestjs/common';
import { ProjectsNotificationsService } from './projects-notifications.service';
import { CreateNotificationUseCase } from '../core/use-cases/create-notification.use-case';
import { DeleteNotificationUseCase } from '../core/use-cases/delete-notification.use-case';

@Module({
  providers: [ProjectsNotificationsService],
  exports: [ProjectsNotificationsService],
})
export class ProjectsNotificationsModule {}
