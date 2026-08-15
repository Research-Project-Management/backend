import {
  Controller,
  Post,
  Get,
  Put,
  Body,
  Query,
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
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

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

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }

  @Get('user')
  @UseGuards(JwtAuthGuard)
  async getUser(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }

  @Put('profile')
  @UseGuards(JwtAuthGuard)
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(userId, dto);
  }

  @Put('change-password')
  @UseGuards(JwtAuthGuard)
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() _dto: ForgotPasswordDto) {
    return {
      message: 'If this email is registered, a reset link will be sent.',
    };
  }

  @Get('search-users')
  @UseGuards(JwtAuthGuard)
  async searchUsers(
    @Query('query') query: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.authService.searchUsers(query, userId);
  }
}
