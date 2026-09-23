import { NotFoundException } from '@nestjs/common';

export class NotificationNotFoundException extends NotFoundException {
  constructor(idOrKey: string) {
    super(`Notification with identifier '${idOrKey}' was not found`);
  }
}
