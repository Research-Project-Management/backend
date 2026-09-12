/**
 * Authentication (Authn) Module
 * Handles user authentication, credential verification, JWT lifecycle,
 * refresh token rotation, OAuth provider exchange, and password reset flows.
 */
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthnService } from './authn.service';
import { AuthnController } from './authn.controller';
import { AuthnRepository } from './authn.repository';
import { AuthGuard, JwtAuthGuard } from './guards/auth.guard';
import { CacheModule } from '@/core/cache/cache.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    CacheModule,
    UserModule,
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
  controllers: [AuthnController],
  providers: [AuthnService, AuthnRepository, AuthGuard, JwtAuthGuard],
  exports: [AuthnService, AuthnRepository, JwtModule, AuthGuard, JwtAuthGuard],
})
export class AuthnModule {}
