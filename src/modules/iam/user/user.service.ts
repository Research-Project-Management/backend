import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { UserRepository } from './user.repository';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import * as bcrypt from 'bcrypt';
import { AuthProvider, User } from '@prisma/client';
import { FederatedIdentityRepository } from './federated-identity.repository';

@Injectable()
export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly federatedRepo: FederatedIdentityRepository,
  ) {}

  async findFederatedIdentity(provider: AuthProvider, subjectId: string) {
    return this.federatedRepo.findByProviderSubject(provider, subjectId);
  }

  async linkFederatedIdentity(data: {
    userId: string;
    provider: AuthProvider;
    providerSubjectId: string;
    email?: string;
    profileData?: Record<string, unknown>;
  }) {
    return this.federatedRepo.linkIdentity(data);
  }

  private formatUser(user: User | null | undefined) {
    if (!user) return null;
    const { password, ...rest } = user;
    return rest;
  }

  async getMe(userId: string) {
    const user = await this.userRepo.findUserById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return { user: this.formatUser(user) };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.userRepo.updateUser(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
    });

    return { user: this.formatUser(user) };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.userRepo.findUserById(userId);

    if (!user || !user.password) {
      throw new BadRequestException('User has no password set');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.userRepo.updateUser(userId, {
      password: hashedPassword,
    });
    await this.userRepo.revokeAllUserRefreshTokens(userId);

    return { message: 'Password updated successfully' };
  }

  async searchUsers(query: string, currentUserId?: string) {
    const users = await this.userRepo.searchUsers(query, currentUserId);
    return { users };
  }

  async deleteMe(userId: string) {
    await this.userRepo.softDelete(userId);
    await this.userRepo.revokeAllUserRefreshTokens(userId);
    return { success: true, message: 'Account deleted successfully' };
  }
}
