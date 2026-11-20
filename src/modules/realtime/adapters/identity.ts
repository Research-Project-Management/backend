import { Injectable } from '@nestjs/common';
import type { IdentityUserSession } from '@/modules/identity/identity.facade';
import { UserRepository } from '@/modules/identity/user/user.repository';

@Injectable()
export class RealtimeIdentityLookup {
  constructor(private readonly userRepository: UserRepository) {}

  public async validateUser(
    userId: string,
  ): Promise<IdentityUserSession | null> {
    const user = await this.userRepository.findById(userId);
    if (!user || user.status === 'suspended' || user.status === 'deactivated') {
      return null;
    }

    return {
      userId: user.id,
      email: user.email || '',
      name: user.profile?.name ?? 'User',
      avatar: user.profile?.avatar ?? null,
      status: user.status,
      isVerified: user.status === 'active',
    };
  }
}
