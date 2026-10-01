import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import {
  IIntegrationProvider,
  IntegrationProviderType,
  OAuthExchangeResult,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './integration-provider.interface';
import { RedisCacheService } from '@/core/cache/redis.service';

@Injectable()
export class ZoteroProvider implements IIntegrationProvider {
  readonly provider: IntegrationProviderType = 'zotero';
  private readonly logger = new Logger(ZoteroProvider.name);

  private readonly clientKey: string;
  private readonly clientSecret: string;
  private readonly isMockMode: boolean;

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
    this.isMockMode = !this.clientKey || !this.clientSecret;

    if (this.isMockMode) {
      this.logger.warn(
        'Zotero client credentials not configured. Operating in development mock/sandbox mode.',
      );
    }
  }

  async initiateOAuth(
    userId: string,
    redirectUri: string,
  ): Promise<OAuthInitiationResult> {
    if (this.isMockMode) {
      const mockToken = `mock_req_${randomBytes(8).toString('hex')}`;
      const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
      const mockAuthUrl = `${redirectUri}?oauth_token=${mockToken}&oauth_verifier=mock_verified&state=${state}`;
      this.cleanExpiredInMemoryTokens();
      this.inMemoryStore.set(mockToken, {
        secret: 'mock_secret',
        userId,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
      return {
        authUrl: mockAuthUrl,
        state,
        requestTokenSecret: 'mock_secret',
      };
    }

    try {
      const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
      const requestTokenUrl = 'https://www.zotero.org/oauth/request';

      // Include state in callback URL if possible so Zotero can preserve it
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
        throw new Error(
          `Failed to request Zotero token: ${response.status} ${response.statusText}`,
        );
      }

      const body = await response.text();
      const parsed = new URLSearchParams(body);
      const requestToken = parsed.get('oauth_token');
      const requestTokenSecret = parsed.get('oauth_token_secret');

      if (!requestToken) {
        throw new Error('Zotero did not return an oauth_token');
      }

      // Preserve requestTokenSecret & userId for OAuth 1.0a access exchange (15 min TTL)
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

      // Official Zotero OAuth authorize endpoint with scoped permissions
      const authUrl = `https://www.zotero.org/oauth/authorize?oauth_token=${encodeURIComponent(
        requestToken,
      )}&library_access=1&notes_access=1&write_access=1&all_groups=read`;

      return {
        authUrl,
        state,
        requestTokenSecret: requestTokenSecret || '',
      };
    } catch (err: any) {
      this.logger.error(
        `Error initiating Zotero OAuth: ${err.message}`,
        err.stack,
      );
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
    if (this.isMockMode || params.codeOrToken.startsWith('mock_')) {
      const mockEntry = this.inMemoryStore.get(params.codeOrToken);
      this.inMemoryStore.delete(params.codeOrToken);
      return {
        accessToken: `zotero_mock_key_${randomBytes(16).toString('hex')}`,
        providerUserId: '1234567',
        accountName: 'Zotero Researcher (Sandbox)',
        accountEmail: 'researcher@zotero.sandbox',
        metadata: { isMock: true },
        userId: mockEntry?.userId,
      };
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
            tokenSecret = (stored as any).secret || tokenSecret;
            resolvedUserId = (stored as any).userId;
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
    } catch (err: any) {
      this.logger.error(
        `Error exchanging Zotero token: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async fetchCollections(
    decryptedToken: string,
    providerUserId: string,
  ): Promise<RemoteCollectionItem[]> {
    if (decryptedToken.includes('mock')) {
      return [
        { id: 'all', name: 'My Library (All Items)', itemCount: 65 },
        { id: 'COLL_1', name: 'My Publications', itemCount: 12 },
        { id: 'COLL_2', name: 'Deep Learning & NLP', itemCount: 45 },
        { id: 'COLL_3', name: 'Quantum Information', itemCount: 8 },
      ];
    }

    try {
      const results: RemoteCollectionItem[] = [];

      // 1. Probe total item count in user's root personal library
      try {
        const rootHeadRes = await fetch(
          `https://api.zotero.org/users/${providerUserId}/items/top?limit=1`,
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
      } catch (probeErr: any) {
        this.logger.warn(
          `Could not probe Zotero root library: ${probeErr.message}`,
        );
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
        const url = `https://api.zotero.org/users/${providerUserId}/collections?limit=${limit}&start=${start}`;
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

        const collections = (await response.json()) as any[];
        for (const col of collections) {
          results.push({
            id: col.key,
            name: col.data.name || 'Untitled Collection',
            itemCount: col.meta?.numItems || 0,
            parentCollectionId: col.data.parentCollection || null,
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
          `https://api.zotero.org/users/${providerUserId}/groups`,
          {
            headers: {
              'Zotero-API-Key': decryptedToken,
              'Zotero-API-Version': '3',
              'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
            },
          },
        );

        if (groupsRes.ok) {
          const groups = (await groupsRes.json()) as any[];
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
              const groupCols = (await groupColRes.json()) as any[];
              for (const col of groupCols) {
                results.push({
                  id: `group:${groupId}:${col.key}`,
                  name: `[Group: ${groupName}] ${col.data?.name || 'Untitled'}`,
                  itemCount: col.meta?.numItems || 0,
                  parentCollectionId: col.data?.parentCollection
                    ? `group:${groupId}:${col.data.parentCollection}`
                    : null,
                });
              }
            }
          }
        }
      } catch (groupErr: any) {
        this.logger.warn(`Could not probe Zotero groups: ${groupErr.message}`);
      }

      return results;
    } catch (err: any) {
      this.logger.error(
        `Error fetching Zotero collections: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  async fetchCollectionBibtex(
    decryptedToken: string,
    providerUserId: string,
    collectionId: string,
  ): Promise<string> {
    if (decryptedToken.includes('mock')) {
      return `@article{vaswani2017attention,
  title={Attention is all you need},
  author={Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob and Jones, Llion and Gomez, Aidan N and Kaiser, {\\L}ukasz and Polosukhin, Illia},
  journal={Advances in neural information processing systems},
  volume={30},
  year={2017}
}

@article{devlin2018bert,
  title={BERT: Pre-training of deep bidirectional transformers for language understanding},
  author={Devlin, Jacob and Chang, Ming-Wei and Lee, Kenton and Toutanova, Kristina},
  journal={arXiv preprint arXiv:1810.04805},
  year={2018}
}`;
    }

    try {
      let baseUrl = '';

      if (collectionId.startsWith('group:')) {
        const parts = collectionId.split(':');
        const groupId = parts[1];
        const colKey = parts[2] || 'all';

        if (colKey === 'all' || !colKey) {
          baseUrl = `https://api.zotero.org/groups/${groupId}/items/top`;
        } else {
          baseUrl = `https://api.zotero.org/groups/${groupId}/collections/${colKey}/items/top`;
        }
      } else {
        if (
          !collectionId ||
          collectionId === 'all' ||
          collectionId === 'library' ||
          collectionId === 'root'
        ) {
          baseUrl = `https://api.zotero.org/users/${providerUserId}/items/top`;
        } else {
          baseUrl = `https://api.zotero.org/users/${providerUserId}/collections/${collectionId}/items/top`;
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
      } while (start < totalResults && start < 2000); // 2000 items maximum safety limit

      return bibtexChunks.join('\n\n');
    } catch (err: any) {
      this.logger.error(
        `Error fetching Zotero BibTeX: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  // --- OAuth 1.0a Helpers (RFC 5849 compliant) ---

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
