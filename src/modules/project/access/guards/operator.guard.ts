import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { AccessConfigService } from '../config/access.config';

@Injectable()
export class OperatorGuard implements CanActivate {
  private readonly logger = new Logger(OperatorGuard.name);

  constructor(private readonly accessConfigService: AccessConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const userId = user?.sub || user?.id || user?.userId;

    if (!user || !userId) {
      throw new UnauthorizedException({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
      });
    }

    const isOperator = this.accessConfigService.isOperator(userId);
    if (!isOperator) {
      this.logger.warn(
        `Operator access denied for user ${userId} on ${request.method} ${request.url}`,
      );
      throw new ForbiddenException({
        statusCode: 403,
        code: 'OPERATOR_REQUIRED',
        message: 'Operator privileges required',
      });
    }

    return true;
  }
}
