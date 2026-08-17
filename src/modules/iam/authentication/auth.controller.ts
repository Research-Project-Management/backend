import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  Query,
  Redirect,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Identity')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto) {
    return this.authService.registerUser(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('google')
  @Redirect()
  googleAuthMethod() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const redirectUri = apiUrl + '/auth/google/callback';
    const url =
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=' +
      clientId +
      '&redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&response_type=code&scope=' +
      encodeURIComponent('openid email profile') +
      '&access_type=offline&prompt=consent';
    return { url, statusCode: 302 };
  }

  @Get('google/callback')
  @Redirect()
  async googleCallback(
    @Query('code') code: string,
    @Query('error') error: string,
  ) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:2915';
    if (error || !code) {
      return {
        url: clientUrl + '/login?error=' + (error || 'no_code'),
        statusCode: 302,
      };
    }

    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      const apiUrl = process.env.API_URL || 'http://localhost:3000';
      const redirectUri = apiUrl + '/auth/google/callback';

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId || '',
          client_secret: clientSecret || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        return {
          url: clientUrl + '/login?error=google_token_failed',
          statusCode: 302,
        };
      }

      const userRes = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: { Authorization: 'Bearer ' + tokenData.access_token },
        },
      );
      const googleUser = (await userRes.json()) as {
        id: string;
        email?: string;
        name?: string;
        picture?: string;
      };

      const result = await this.authService.handleOAuth({
        id: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatar: googleUser.picture,
        provider: 'google',
      });

      return {
        url:
          clientUrl +
          '/auth/callback?accessToken=' +
          result.accessToken +
          '&refreshToken=' +
          result.refreshToken,
        statusCode: 302,
      };
    } catch (err) {
      return { url: clientUrl + '/login?error=oauth_error', statusCode: 302 };
    }
  }

  @Get('github')
  @Redirect()
  githubAuthMethod() {
    const clientId = process.env.GITHUB_CLIENT_ID;
    const apiUrl = process.env.API_URL || 'http://localhost:3000';
    const redirectUri = apiUrl + '/auth/github/callback';
    const url =
      'https://github.com/login/oauth/authorize?client_id=' +
      clientId +
      '&redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&scope=' +
      encodeURIComponent('read:user user:email');
    return { url, statusCode: 302 };
  }

  @Get('github/callback')
  @Redirect()
  async githubCallback(
    @Query('code') code: string,
    @Query('error') error: string,
  ) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:2915';
    if (error || !code) {
      return {
        url: clientUrl + '/login?error=' + (error || 'no_code'),
        statusCode: 302,
      };
    }

    try {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;

      const tokenRes = await fetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );

      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        return {
          url: clientUrl + '/login?error=github_token_failed',
          statusCode: 302,
        };
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: 'Bearer ' + tokenData.access_token,
          'User-Agent': 'RPM-App',
        },
      });
      const githubUser = (await userRes.json()) as {
        id: number;
        email?: string;
        name?: string;
        login?: string;
        avatar_url?: string;
      };

      let email = githubUser.email;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: 'Bearer ' + tokenData.access_token,
            'User-Agent': 'RPM-App',
          },
        });
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
        }>;
        if (Array.isArray(emails)) {
          const primary = emails.find((ei) => ei.primary);
          email = primary?.email || emails[0]?.email;
        }
      }

      const result = await this.authService.handleOAuth({
        id: String(githubUser.id),
        email,
        name: githubUser.name || githubUser.login,
        avatar: githubUser.avatar_url,
        provider: 'github',
      });

      return {
        url:
          clientUrl +
          '/auth/callback?accessToken=' +
          result.accessToken +
          '&refreshToken=' +
          result.refreshToken,
        statusCode: 302,
      };
    } catch (err) {
      return { url: clientUrl + '/login?error=oauth_error', statusCode: 302 };
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Get('logout')
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto?: RefreshTokenDto) {
    return this.authService.logout(dto?.refreshToken);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() _dto: ForgotPasswordDto) {
    return {
      message: 'If this email is registered, a reset link will be sent.',
    };
  }
}
