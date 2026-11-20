import { isOriginAllowed } from '@/core/http/setup/allowed-origins';

export const REALTIME_NAMESPACES = {
  MANUSCRIPTS: '/manuscripts',
  CHAT: '/chat',
} as const;

export type RealtimeNamespace =
  (typeof REALTIME_NAMESPACES)[keyof typeof REALTIME_NAMESPACES];

export interface WsCorsOptions {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => void;
  credentials: boolean;
}

export function createWsCorsOptions(): WsCorsOptions {
  return {
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      callback(null, isOriginAllowed(origin));
    },
    credentials: true,
  };
}
