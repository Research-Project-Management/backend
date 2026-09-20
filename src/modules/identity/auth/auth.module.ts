/**
 * Authentication (Authn) Module
 * Handles user authentication, credential verification, JWT lifecycle,
 * refresh token rotation, OAuth provider exchange, and password reset flows.
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthGuard, JwtAuthGuard } from './guards/auth.guard';
import { VerifiedEmailGuard } from './guards/verified-email.guard';
import { CacheModule } from '@/core/cache/cache.module';
import { UserModule } from '../user/user.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    CacheModule,
    UserModule,
    AuditModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is required');
        }

        return {
          secret,
          signOptions: {
            expiresIn:
              (configService.get<string>('JWT_EXPIRES_IN') as any) || '7d',
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, AuthGuard, VerifiedEmailGuard],
  exports: [
    AuthService,
    AuthRepository,
    JwtModule,
    AuthGuard,
    VerifiedEmailGuard,
  ],
})
export class AuthModule {}

export const AuthnModule = AuthModule;
export type AuthnModule = AuthModule;
