import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthRepository } from './auth.repository';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { User } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly authRepo: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  private formatUser(user: User): Omit<User, 'password'>;
  private formatUser(user: null | undefined): null;
  private formatUser(
    user: User | null | undefined,
  ): Omit<User, 'password'> | null;
  private formatUser(user: User | null | undefined) {
    if (!user) return null;
    const { password, ...rest } = user;
    return rest;
  }

  private async generateTokens(user: {
    id: string;
    email: string | null;
    name: string;
  }) {
    const payload = {
      sub: user.id,
      id: user.id,
      email: user.email,
      name: user.name,
    };

    const accessTokenSecret =
      this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    const refreshTokenSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      process.env.JWT_REFRESH_SECRET;

    if (!accessTokenSecret || !refreshTokenSecret) {
      throw new UnauthorizedException(
        'JWT secrets are not configured in environment',
      );
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: accessTokenSecret,
        expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
          '1h') as any,
      }),
      this.jwtService.signAsync(payload, {
        secret: refreshTokenSecret,
        expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ||
          '30d') as any,
      }),
    ]);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.authRepo.createRefreshToken({
      userId: user.id,
      token: refreshToken,
      expiresAt,
    });

    return { accessToken, refreshToken };
  }

  async registerUser(dto: RegisterDto) {
    const existing = await this.authRepo.findUserByEmail(dto.email);

    if (existing) {
      throw new BadRequestException('Email is already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.authRepo.createUser({
      email: dto.email.toLowerCase(),
      password: hashedPassword,
      name: dto.name || 'User',
      avatar: dto.avatar || null,
      isVerified: true,
    });

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.authRepo.findUserByEmail(dto.email);

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenRecord = await this.authRepo.findRefreshToken(refreshToken);

    if (
      !tokenRecord ||
      tokenRecord.revokedAt ||
      tokenRecord.expiresAt < new Date()
    ) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    const payload = {
      sub: tokenRecord.user.id,
      id: tokenRecord.user.id,
      email: tokenRecord.user.email,
      name: tokenRecord.user.name,
    };

    const accessTokenSecret =
      this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    if (!accessTokenSecret) {
      throw new UnauthorizedException(
        'JWT secret is not configured in environment',
      );
    }
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: accessTokenSecret,
      expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
        '1h') as any,
    });

    return {
      accessToken,
      user: this.formatUser(tokenRecord.user),
    };
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      await this.authRepo.revokeRefreshToken(refreshToken);
    }
    return { message: 'Logged out successfully' };
  }

  async getMe(userId: string) {
    const user = await this.authRepo.findUserById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return { user: this.formatUser(user) };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.authRepo.updateUser(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
    });

    return { user: this.formatUser(user) };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.authRepo.findUserById(userId);

    if (!user || !user.password) {
      throw new BadRequestException('User has no password set');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.authRepo.updateUser(userId, {
      password: hashedPassword,
    });

    return { message: 'Password updated successfully' };
  }

  async searchUsers(query: string, currentUserId?: string) {
    const users = await this.authRepo.searchUsers(query, currentUserId);
    return { users };
  }

  async handleOAuth(profile: {
    id: string;
    email?: string;
    name?: string;
    avatar?: string;
    provider: 'google' | 'github';
  }) {
    const providerField: 'googleId' | 'githubId' =
      profile.provider === 'google' ? 'googleId' : 'githubId';

    let user = await this.authRepo.findUserByOAuth(
      providerField,
      profile.id,
      profile.email,
    );

    if (!user) {
      user = await this.authRepo.createUser({
        email: profile.email?.toLowerCase() || null,
        name: profile.name || 'User',
        avatar: profile.avatar || null,
        [providerField]: profile.id,
        isVerified: true,
      });
    } else if (!user[providerField]) {
      user = await this.authRepo.updateUser(user.id, {
        [providerField]: profile.id,
      });
    }

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }
}

export { AuthService as AuthenticationService };
