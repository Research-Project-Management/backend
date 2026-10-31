import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import {
  IIntegrationProvider,
  IntegrationProviderType,
  OAuthExchangeResult,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './integration-provider.interface';
import { RedisCacheService } from '@/core';

interface ZoteroCollectionPayload {
  key: string;
  data: {
    name?: string;
    parentCollection?: string | false | null;
  };
  meta?: {
    numItems?: number;
  };
}

interface ZoteroGroupPayload {
  id: number | string;
  data?: {
    name?: string;
  };
  meta?: {
    numItems?: number;
  };
}

@Injectable()
export class ZoteroProvider implements IIntegrationProvider {
  readonly provider: IntegrationProviderType = 'zotero';
  private readonly logger = new Logger(ZoteroProvider.name);

  private readonly clientKey: string;
  private readonly clientSecret: string;

  private readonly inMemoryStore = new Map<
    string,
    { secret: string; userId: string; expiresAt: number }
  >();

  private cleanExpiredInMemoryTokens() {
    const now = Date.now();
    for (const [key, val] of this.inMemoryStore.entries()) {
      if (val.expiresAt <= now) {
        this.inMemoryStore.delete(key);
      }
    }
  }

  constructor(@Optional() private readonly redis?: RedisCacheService) {
    this.clientKey = process.env.ZOTERO_CLIENT_KEY || '';
    this.clientSecret = process.env.ZOTERO_CLIENT_SECRET || '';
  }

  async initiateOAuth(
    userId: string,
    redirectUri: string,
  ): Promise<OAuthInitiationResult> {
    if (!this.clientKey || !this.clientSecret) {
      throw new BadRequestException(
        'Zotero OAuth credentials (ZOTERO_CLIENT_KEY / ZOTERO_CLIENT_SECRET) are not configured on the server. Please connect using a Personal API Key.',
      );
    }

    try {
      const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
      const requestTokenUrl = 'https://www.zotero.org/oauth/request';

      let effectiveCallback = redirectUri;
      try {
        const url = new URL(redirectUri);
        url.searchParams.set('state', state);
        effectiveCallback = url.toString();
      } catch {
        // Preserve default redirectUri if URL parsing fails
      }

      const oauthParams = this.buildOAuthParams({
        oauth_consumer_key: this.clientKey,
        oauth_callback: effectiveCallback,
      });

      const signature = this.generateOAuthSignature(
        'POST',
        requestTokenUrl,
        oauthParams,
        this.clientSecret,
        '',
      );

      oauthParams.oauth_signature = signature;
      const authHeader = this.buildAuthorizationHeader(oauthParams);

      const response = await fetch(requestTokenUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
        },
      });

      if (!response.ok) {
        throw new BadRequestException(
          `Zotero OAuth endpoint rejected request (${response.status} ${response.statusText}). Please connect using your Zotero Personal API Key.`,
        );
      }

      const body = await response.text();
      const parsed = new URLSearchParams(body);
      const requestToken = parsed.get('oauth_token');
      const requestTokenSecret = parsed.get('oauth_token_secret');

      if (!requestToken) {
        throw new Error('Zotero did not return an oauth_token');
      }

      this.cleanExpiredInMemoryTokens();
      this.inMemoryStore.set(requestToken, {
        secret: requestTokenSecret || '',
        userId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });

      if (this.redis) {
        await this.redis.set(
          `oauth:zotero:${requestToken}`,
          JSON.stringify({ secret: requestTokenSecret || '', userId }),
          900,
        );
      }

      const authUrl = `https://www.zotero.org/oauth/authorize?oauth_token=${encodeURIComponent(
        requestToken,
      )}&library_access=1&notes_access=1&write_access=1&all_groups=read`;

      return {
        authUrl,
        state,
        requestTokenSecret: requestTokenSecret || '',
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error initiating Zotero OAuth: ${errMsg}`, stack);
      throw err;
    }
  }

  async handleCallback(params: {
    codeOrToken: string;
    verifier?: string;
    state?: string;
    secret?: string;
    redirectUri: string;
  }): Promise<OAuthExchangeResult> {
    if (!this.clientKey || !this.clientSecret) {
      throw new BadRequestException(
        'Zotero OAuth credentials are not configured on the server.',
      );
    }

    try {
      let tokenSecret = params.secret || '';
      let resolvedUserId: string | undefined;

      if (this.redis) {
        const stored = await this.redis.get<
          string | { secret: string; userId: string }
        >(`oauth:zotero:${params.codeOrToken}`);
        if (stored) {
          if (typeof stored === 'string') {
            try {
              const parsed = JSON.parse(stored);
              tokenSecret = parsed.secret || tokenSecret;
              resolvedUserId = parsed.userId;
            } catch {
              tokenSecret = stored;
            }
          } else if (typeof stored === 'object' && stored !== null) {
            const storedRecord = stored as Record<string, unknown>;
            if (typeof storedRecord.secret === 'string') {
              tokenSecret = storedRecord.secret;
            }
            if (typeof storedRecord.userId === 'string') {
              resolvedUserId = storedRecord.userId;
            }
          }
        }
      }

      if (!resolvedUserId && this.inMemoryStore.has(params.codeOrToken)) {
        const entry = this.inMemoryStore.get(params.codeOrToken)!;
        tokenSecret = entry.secret || tokenSecret;
        resolvedUserId = entry.userId;
      }

      const accessTokenUrl = 'https://www.zotero.org/oauth/access';
      const oauthParams = this.buildOAuthParams({
        oauth_consumer_key: this.clientKey,
        oauth_token: params.codeOrToken,
        oauth_verifier: params.verifier || '',
      });

      const signature = this.generateOAuthSignature(
        'POST',
        accessTokenUrl,
        oauthParams,
        this.clientSecret,
        tokenSecret,
      );

      oauthParams.oauth_signature = signature;
      const authHeader = this.buildAuthorizationHeader(oauthParams);

      const response = await fetch(accessTokenUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Zotero token exchange failed with status ${response.status} ${response.statusText}`,
        );
      }

      const body = await response.text();
      const parsed = new URLSearchParams(body);
      const apiKey = parsed.get('oauth_token');
      const userID = parsed.get('userID');
      const username = parsed.get('username') || `User ${userID}`;

      if (!apiKey || !userID) {
        throw new Error('Zotero access response missing oauth_token or userID');
      }

      this.inMemoryStore.delete(params.codeOrToken);
      if (this.redis) {
        await this.redis.del(`oauth:zotero:${params.codeOrToken}`);
      }

      return {
        accessToken: apiKey,
        providerUserId: userID,
        accountName: username,
        accountEmail: `${username}@zotero.org`,
        metadata: {
          username,
          userID,
        },
        userId: resolvedUserId,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error exchanging Zotero token: ${errMsg}`, stack);
      throw err;
    }
  }

  async fetchCollections(
    decryptedToken: string,
    providerUserId: string,
  ): Promise<RemoteCollectionItem[]> {
    try {
      const results: RemoteCollectionItem[] = [];

      // 1. Probe total item count in user's root personal library
      try {
        const rootHeadRes = await fetch(
          `https://api.zotero.org/users/${encodeURIComponent(providerUserId)}/items/top?limit=1`,
          {
            headers: {
              'Zotero-API-Key': decryptedToken,
              'Zotero-API-Version': '3',
              'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
            },
          },
        );
        const totalItemsHeader = rootHeadRes.headers.get('Total-Results');
        const totalItems = totalItemsHeader
          ? parseInt(totalItemsHeader, 10)
          : 0;
        results.push({
          id: 'all',
          name: 'My Library (Entire Library)',
          itemCount: totalItems,
        });
      } catch (probeErr: unknown) {
        const errMsg =
          probeErr instanceof Error ? probeErr.message : String(probeErr);
        this.logger.warn(`Could not probe Zotero root library: ${errMsg}`);
        results.push({
          id: 'all',
          name: 'My Library (Entire Library)',
          itemCount: 0,
        });
      }

      // 2. Fetch personal collections with pagination
      let start = 0;
      const limit = 100;
      let totalCollections = 0;

      do {
        const url = `https://api.zotero.org/users/${encodeURIComponent(providerUserId)}/collections?limit=${limit}&start=${start}`;
        const response = await fetch(url, {
          headers: {
            'Zotero-API-Key': decryptedToken,
            'Zotero-API-Version': '3',
            'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
          },
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch Zotero collections: status ${response.status} ${response.statusText}`,
          );
        }

        const collections =
          (await response.json()) as ZoteroCollectionPayload[];
        for (const col of collections) {
          results.push({
            id: col.key,
            name: col.data.name || 'Untitled Collection',
            itemCount: col.meta?.numItems || 0,
            parentCollectionId:
              typeof col.data.parentCollection === 'string'
                ? col.data.parentCollection
                : null,
          });
        }

        const totalHeader = response.headers.get('Total-Results');
        totalCollections = totalHeader
          ? parseInt(totalHeader, 10)
          : results.length;
        start += limit;
      } while (start < totalCollections && start < 500);

      // 3. Fetch user's group libraries
      try {
        const groupsRes = await fetch(
          `https://api.zotero.org/users/${encodeURIComponent(providerUserId)}/groups`,
          {
            headers: {
              'Zotero-API-Key': decryptedToken,
              'Zotero-API-Version': '3',
              'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
            },
          },
        );

        if (groupsRes.ok) {
          const groups = (await groupsRes.json()) as ZoteroGroupPayload[];
          for (const group of groups) {
            const groupId = group.id;
            const groupName = group.data?.name || `Group ${groupId}`;

            results.push({
              id: `group:${groupId}:all`,
              name: `[Group: ${groupName}] Entire Group Library`,
              itemCount: group.meta?.numItems || 0,
            });

            const groupColRes = await fetch(
              `https://api.zotero.org/groups/${groupId}/collections?limit=100`,
              {
                headers: {
                  'Zotero-API-Key': decryptedToken,
                  'Zotero-API-Version': '3',
                  'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
                },
              },
            );

            if (groupColRes.ok) {
              const groupCols =
                (await groupColRes.json()) as ZoteroCollectionPayload[];
              for (const col of groupCols) {
                results.push({
                  id: `group:${groupId}:${col.key}`,
                  name: `[Group: ${groupName}] ${col.data?.name || 'Untitled'}`,
                  itemCount: col.meta?.numItems || 0,
                  parentCollectionId:
                    typeof col.data?.parentCollection === 'string'
                      ? `group:${groupId}:${col.data.parentCollection}`
                      : null,
                });
              }
            }
          }
        }
      } catch (groupErr) {
        this.logger.warn(`Could not probe Zotero groups: ${String(groupErr)}`);
      }

      return results;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error fetching Zotero collections: ${errMsg}`, stack);
      throw err;
    }
  }

  async fetchCollectionBibtex(
    decryptedToken: string,
    providerUserId: string,
    collectionId: string,
  ): Promise<string> {
    try {
      let baseUrl = '';

      if (collectionId.startsWith('group:')) {
        const parts = collectionId.split(':');
        const groupId = parts[1];
        const colKey = parts[2] || 'all';

        if (colKey === 'all' || !colKey) {
          baseUrl = `https://api.zotero.org/groups/${encodeURIComponent(groupId)}/items/top`;
        } else {
          baseUrl = `https://api.zotero.org/groups/${encodeURIComponent(groupId)}/collections/${encodeURIComponent(colKey)}/items/top`;
        }
      } else {
        if (
          !collectionId ||
          collectionId === 'all' ||
          collectionId === 'library' ||
          collectionId === 'root'
        ) {
          baseUrl = `https://api.zotero.org/users/${encodeURIComponent(providerUserId)}/items/top`;
        } else {
          baseUrl = `https://api.zotero.org/users/${encodeURIComponent(providerUserId)}/collections/${encodeURIComponent(collectionId)}/items/top`;
        }
      }

      let start = 0;
      const limit = 100;
      const bibtexChunks: string[] = [];
      let totalResults = 0;

      do {
        const url = `${baseUrl}?format=bibtex&limit=${limit}&start=${start}`;
        const response = await fetch(url, {
          headers: {
            'Zotero-API-Key': decryptedToken,
            'Zotero-API-Version': '3',
            'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
          },
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch Zotero BibTeX: status ${response.status} ${response.statusText}`,
          );
        }

        const chunk = await response.text();
        if (chunk.trim()) {
          bibtexChunks.push(chunk.trim());
        }

        const totalResultsHeader = response.headers.get('Total-Results');
        if (totalResultsHeader) {
          totalResults = parseInt(totalResultsHeader, 10) || 0;
        } else {
          totalResults = bibtexChunks.length * limit;
        }

        start += limit;
      } while (start < totalResults && start < 2000);

      return bibtexChunks.join('\n\n');
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error fetching Zotero BibTeX: ${errMsg}`, stack);
      throw err;
    }
  }

  private buildOAuthParams(
    custom: Record<string, string>,
  ): Record<string, string> {
    return {
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_version: '1.0',
      ...custom,
    };
  }

  private generateOAuthSignature(
    method: string,
    url: string,
    params: Record<string, string>,
    consumerSecret: string,
    tokenSecret: string,
  ): string {
    const sortedKeys = Object.keys(params).sort();
    const paramString = sortedKeys
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&');

    const baseString = [
      method.toUpperCase(),
      encodeURIComponent(url),
      encodeURIComponent(paramString),
    ].join('&');

    const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;
    return createHmac('sha1', signingKey).update(baseString).digest('base64');
  }

  private buildAuthorizationHeader(params: Record<string, string>): string {
    const pairs = Object.keys(params)
      .sort()
      .map(
        (k) => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`,
      );
    return `OAuth ${pairs.join(', ')}`;
  }
}
