export type IntegrationProviderType = 'zotero' | 'mendeley' | 'orcid' | 'github';

export const INTEGRATION_PROVIDERS: readonly IntegrationProviderType[] = [
  'zotero',
  'mendeley',
  'orcid',
  'github',
] as const;

export function isValidProvider(provider: string): provider is IntegrationProviderType {
  return INTEGRATION_PROVIDERS.includes(provider as IntegrationProviderType);
}

export interface OAuthInitiationResult {
  authUrl: string;
  state: string;
  requestTokenSecret?: string;
}

export interface OAuthExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  providerUserId: string;
  accountName?: string;
  accountEmail?: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteCollectionItem {
  id: string;
  name: string;
  itemCount: number;
  parentCollectionId?: string | null;
}

export interface IIntegrationProvider {
  readonly provider: IntegrationProviderType;
  initiateOAuth(userId: string, redirectUri: string): Promise<OAuthInitiationResult>;
  handleCallback(params: {
    codeOrToken: string;
    verifier?: string;
    state?: string;
    secret?: string;
    redirectUri: string;
  }): Promise<OAuthExchangeResult>;
  fetchCollections(decryptedToken: string, providerUserId: string): Promise<RemoteCollectionItem[]>;
  fetchCollectionBibtex(
    decryptedToken: string,
    providerUserId: string,
    collectionId: string,
  ): Promise<string>;
}
