import { Prisma, User, UserProfile } from '@prisma/client';
import {
  decryptToken,
  encryptToken,
} from '@/modules/integrations/utils/integration-crypto.utils';
import { SanitizedUser } from '../types/user.type';

export interface PublicAiByokConfig {
  enabled: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string;
}

export function sanitizeUser(
  user: (User & { profile?: UserProfile | null }) | null | undefined,
): SanitizedUser | null {
  if (!user) return null;
  const { password: _password, profile, ...rest } = user;
  return {
    ...rest,
    name: profile?.name ?? 'User',
    avatar: profile?.avatar ?? null,
    profile: profile ?? null,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1024) {
    return `${megabytes.toFixed(2)} MB`;
  }
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(2)} GB`;
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function maskApiKeyHint(rawKey: string): string {
  const clean = rawKey.trim();
  if (!clean) return '';
  if (clean.length <= 8) return '••••••••';
  return `${clean.slice(0, 4)}••••${clean.slice(-4)}`;
}

export function sanitizeEditorConfigForClient(
  rawEditorConfig: Prisma.JsonValue | undefined,
): Prisma.JsonValue {
  const cfg = { ...asRecord(rawEditorConfig) };
  const rawByok = asRecord(cfg.aiByok);
  if (!Object.keys(rawByok).length) {
    return cfg as Prisma.JsonObject;
  }

  const encryptedKey =
    typeof rawByok.encryptedApiKey === 'string' ? rawByok.encryptedApiKey : '';
  const hint =
    typeof rawByok.apiKeyHint === 'string' && rawByok.apiKeyHint
      ? rawByok.apiKeyHint
      : encryptedKey
        ? '••••••••'
        : '';

  const publicByok: PublicAiByokConfig = {
    enabled: Boolean(rawByok.enabled) && Boolean(encryptedKey),
    provider:
      typeof rawByok.provider === 'string' ? rawByok.provider : 'openai',
    model: typeof rawByok.model === 'string' ? rawByok.model : '',
    baseUrl: typeof rawByok.baseUrl === 'string' ? rawByok.baseUrl : '',
    hasApiKey: Boolean(encryptedKey),
    apiKeyHint: hint,
  };

  return {
    ...cfg,
    aiByok: publicByok as unknown as Prisma.JsonObject,
  };
}

export function mergeAndEncryptEditorConfig(
  existingEditorConfig: Prisma.JsonValue | undefined,
  incomingEditorConfig: unknown,
): Prisma.InputJsonValue {
  const existing = asRecord(existingEditorConfig);
  const incoming = asRecord(incomingEditorConfig);
  const merged: Record<string, unknown> = {
    ...existing,
    ...incoming,
  };

  if ('aiByok' in incoming) {
    const prevByok = asRecord(existing.aiByok);
    const nextByok = asRecord(incoming.aiByok);

    let encryptedApiKey =
      typeof prevByok.encryptedApiKey === 'string'
        ? prevByok.encryptedApiKey
        : '';
    let apiKeyHint =
      typeof prevByok.apiKeyHint === 'string' ? prevByok.apiKeyHint : '';

    if (nextByok.clearApiKey === true) {
      encryptedApiKey = '';
      apiKeyHint = '';
    } else if (
      typeof nextByok.apiKey === 'string' &&
      nextByok.apiKey.trim().length > 0
    ) {
      const cleanKey = nextByok.apiKey.trim();
      encryptedApiKey = encryptToken(cleanKey);
      apiKeyHint = maskApiKeyHint(cleanKey);
    }

    const provider =
      typeof nextByok.provider === 'string' && nextByok.provider.trim()
        ? nextByok.provider.trim()
        : typeof prevByok.provider === 'string'
          ? prevByok.provider
          : 'openai';
    const model =
      typeof nextByok.model === 'string'
        ? nextByok.model.trim()
        : typeof prevByok.model === 'string'
          ? prevByok.model
          : '';
    const baseUrl =
      typeof nextByok.baseUrl === 'string'
        ? nextByok.baseUrl.trim()
        : typeof prevByok.baseUrl === 'string'
          ? prevByok.baseUrl
          : '';
    const enabled =
      typeof nextByok.enabled === 'boolean'
        ? nextByok.enabled
        : Boolean(prevByok.enabled);

    merged.aiByok = {
      enabled: enabled && Boolean(encryptedApiKey),
      provider,
      model,
      baseUrl,
      encryptedApiKey,
      apiKeyHint,
    };
  }

  return merged as Prisma.InputJsonValue;
}

export function resolveDecryptedLlmOverride(
  editorConfig: unknown,
): { api_key: string; model?: string; base_url?: string } | null {
  const cfg = asRecord(editorConfig);
  const byok = asRecord(cfg.aiByok);
  if (
    !byok.enabled ||
    typeof byok.encryptedApiKey !== 'string' ||
    !byok.encryptedApiKey
  ) {
    return null;
  }
  try {
    const apiKey = decryptToken(byok.encryptedApiKey).trim();
    if (!apiKey) return null;
    const model = typeof byok.model === 'string' ? byok.model.trim() : '';
    const baseUrl = typeof byok.baseUrl === 'string' ? byok.baseUrl.trim() : '';
    return {
      api_key: apiKey,
      ...(model ? { model } : {}),
      ...(baseUrl ? { base_url: baseUrl } : {}),
    };
  } catch {
    return null;
  }
}
