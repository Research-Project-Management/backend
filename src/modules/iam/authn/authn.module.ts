import { Module, forwardRef } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthnService } from './authn.service';
import { AuthnController } from './authn.controller';
import { AuthnRepository } from './authn.repository';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CacheModule } from '@/core/cache/cache.module';
import { UserModule } from '../user/user.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    CacheModule,
    forwardRef(() => UserModule),
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
              (configService.get<string>('JWT_EXPIRES_IN') as any) || '15m',
          },
        };
      },
    }),
  ],
  controllers: [AuthnController],
  providers: [AuthnService, AuthnRepository, JwtAuthGuard],
  exports: [AuthnService, AuthnRepository, JwtModule, JwtAuthGuard],
})
export class AuthnModule {}

// Backward compatibility aliases
export const AuthenticationModule = AuthnModule;
export const AuthModule = AuthnModule;
