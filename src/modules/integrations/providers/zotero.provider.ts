import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import {
  IIntegrationProvider,
  IntegrationProviderType,
  OAuthExchangeResult,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './integration-provider.interface';

@Injectable()
export class ZoteroProvider implements IIntegrationProvider {
  readonly provider: IntegrationProviderType = 'zotero';
  private readonly logger = new Logger(ZoteroProvider.name);

  private readonly clientKey: string;
  private readonly clientSecret: string;
  private readonly isMockMode: boolean;

  constructor() {
    this.clientKey = process.env.ZOTERO_CLIENT_KEY || '';
    this.clientSecret = process.env.ZOTERO_CLIENT_SECRET || '';
    this.isMockMode = !this.clientKey || !this.clientSecret;

    if (this.isMockMode) {
      this.logger.warn(
        'Zotero client credentials not configured. Operating in development mock/sandbox mode.',
      );
    }
  }

  async initiateOAuth(userId: string, redirectUri: string): Promise<OAuthInitiationResult> {
    if (this.isMockMode) {
      const mockToken = `mock_req_${randomBytes(8).toString('hex')}`;
      const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
      const mockAuthUrl = `${redirectUri}?oauth_token=${mockToken}&oauth_verifier=mock_verified&state=${state}`;
      return {
        authUrl: mockAuthUrl,
        state,
        requestTokenSecret: 'mock_secret',
      };
    }

    try {
      const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
      const requestTokenUrl = 'https://www.zotero.org/oauth/request';

      const oauthParams = this.buildOAuthParams({
        oauth_consumer_key: this.clientKey,
        oauth_callback: redirectUri,
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
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to request Zotero token: ${response.statusText}`);
      }

      const body = await response.text();
      const parsed = new URLSearchParams(body);
      const requestToken = parsed.get('oauth_token');
      const requestTokenSecret = parsed.get('oauth_token_secret');

      if (!requestToken) {
        throw new Error('Zotero did not return an oauth_token');
      }

      const authUrl = `https://www.zotero.org/oauth/authorize?oauth_token=${encodeURIComponent(
        requestToken,
      )}&library_access=1&notes_access=1&write_access=1&all_groups=read`;

      return {
        authUrl,
        state,
        requestTokenSecret: requestTokenSecret || '',
      };
    } catch (err: any) {
      this.logger.error(`Error initiating Zotero OAuth: ${err.message}`, err.stack);
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
      return {
        accessToken: `zotero_mock_key_${randomBytes(16).toString('hex')}`,
        providerUserId: '1234567',
        accountName: 'Zotero Researcher (Sandbox)',
        accountEmail: 'researcher@zotero.sandbox',
        metadata: { isMock: true },
      };
    }

    try {
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
        params.secret || '',
      );

      oauthParams.oauth_signature = signature;
      const authHeader = this.buildAuthorizationHeader(oauthParams);

      const response = await fetch(accessTokenUrl, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (!response.ok) {
        throw new Error(`Zotero token exchange failed with status ${response.status}`);
      }

      const body = await response.text();
      const parsed = new URLSearchParams(body);
      const apiKey = parsed.get('oauth_token');
      const userID = parsed.get('userID');
      const username = parsed.get('username') || `User ${userID}`;

      if (!apiKey || !userID) {
        throw new Error('Zotero access response missing oauth_token or userID');
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
      };
    } catch (err: any) {
      this.logger.error(`Error exchanging Zotero token: ${err.message}`, err.stack);
      throw err;
    }
  }

  async fetchCollections(
    decryptedToken: string,
    providerUserId: string,
  ): Promise<RemoteCollectionItem[]> {
    if (decryptedToken.includes('mock')) {
      return [
        { id: 'COLL_1', name: 'My Publications', itemCount: 12 },
        { id: 'COLL_2', name: 'Deep Learning & NLP', itemCount: 45 },
        { id: 'COLL_3', name: 'Quantum Information', itemCount: 8 },
      ];
    }

    try {
      const url = `https://api.zotero.org/users/${providerUserId}/collections?limit=100`;
      const response = await fetch(url, {
        headers: {
          'Zotero-API-Key': decryptedToken,
          'Zotero-API-Version': '3',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Zotero collections: status ${response.status}`);
      }

      const collections = (await response.json()) as any[];
      return collections.map((col) => ({
        id: col.key,
        name: col.data.name || 'Untitled Collection',
        itemCount: col.meta?.numItems || 0,
        parentCollectionId: col.data.parentCollection || null,
      }));
    } catch (err: any) {
      this.logger.error(`Error fetching Zotero collections: ${err.message}`, err.stack);
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
      const url = `https://api.zotero.org/users/${providerUserId}/collections/${collectionId}/items?format=bibtex&limit=100`;
      const response = await fetch(url, {
        headers: {
          'Zotero-API-Key': decryptedToken,
          'Zotero-API-Version': '3',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch Zotero BibTeX: status ${response.status}`);
      }

      return await response.text();
    } catch (err: any) {
      this.logger.error(`Error fetching Zotero BibTeX: ${err.message}`, err.stack);
      throw err;
    }
  }

  // --- OAuth 1.0a Helpers ---

  private buildOAuthParams(custom: Record<string, string>): Record<string, string> {
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
      .map((k) => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`);
    return `OAuth ${pairs.join(', ')}`;
  }
}
