import { BadRequestException } from '@nestjs/common';

export class InvalidNotificationException extends BadRequestException {
  constructor(message: string) {
    super(`Invalid notification payload: ${message}`);
  }
}
