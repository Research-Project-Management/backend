import { registerAs } from '@nestjs/config';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type AccessEnforcementMode = 'off' | 'report' | 'enforce';

export interface AccessConfig {
  enforcementMode: AccessEnforcementMode;
  operatorUserIds: string[];
}

export const accessConfig = registerAs('access', (): AccessConfig => {
  const modeRaw = (process.env.ACCESS_CONTROL_MODE || 'enforce').toLowerCase();
  const enforcementMode: AccessEnforcementMode =
    modeRaw === 'off' ? 'off' : modeRaw === 'report' ? 'report' : 'enforce';

  const rawOperatorIds = process.env.OPERATOR_USER_IDS || '';
  const operatorUserIds = rawOperatorIds
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    enforcementMode,
    operatorUserIds,
  };
});

@Injectable()
export class AccessConfigService {
  constructor(private readonly configService: ConfigService) {}

  get config(): AccessConfig {
    return this.configService.get<AccessConfig>('access') || accessConfig();
  }

  get enforcementMode(): AccessEnforcementMode {
    return this.config.enforcementMode;
  }

  get operatorUserIds(): string[] {
    return this.config.operatorUserIds;
  }

  isOperator(userId?: string | null): boolean {
    if (!userId) {
      return false;
    }
    return this.operatorUserIds.includes(userId);
  }
}
