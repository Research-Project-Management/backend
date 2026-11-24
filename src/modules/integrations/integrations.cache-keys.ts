export const INTEGRATIONS_CACHE_KEYS = {
  oauthState: (state: string) => `oauth:state:${state}`,
  zoteroRequestToken: (requestToken: string) => `oauth:zotero:${requestToken}`,
} as const;
