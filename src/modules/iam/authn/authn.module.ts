import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthnService } from './authn.service';
import { AuthnController } from './authn.controller';
import { AuthnRepository } from './authn.repository';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get<string>('JWT_SECRET') || 'your-jwt-secret-here',
        signOptions: {
          expiresIn:
            (configService.get<string>('JWT_EXPIRES_IN') as any) || '15m',
        },
      }),
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
