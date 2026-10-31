import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  IIntegrationProvider,
  IntegrationProviderType,
  OAuthExchangeResult,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './integration-provider.interface';

interface MendeleyAuthor {
  first_name?: string;
  last_name?: string;
}

interface MendeleyDocument {
  id: string;
  type?: string;
  title?: string;
  authors?: MendeleyAuthor[];
  year?: number;
  source?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  abstract?: string;
  identifiers?: {
    doi?: string;
    isbn?: string;
    issn?: string;
    pmid?: string;
    arxiv?: string;
  };
}

@Injectable()
export class MendeleyProvider implements IIntegrationProvider {
  readonly provider: IntegrationProviderType = 'mendeley';
  private readonly logger = new Logger(MendeleyProvider.name);

  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor() {
    this.clientId = process.env.MENDELEY_CLIENT_ID || '';
    this.clientSecret = process.env.MENDELEY_CLIENT_SECRET || '';
  }

  async initiateOAuth(
    userId: string,
    redirectUri: string,
  ): Promise<OAuthInitiationResult> {
    if (!this.clientId || !this.clientSecret) {
      throw new BadRequestException(
        'Mendeley OAuth credentials (MENDELEY_CLIENT_ID / MENDELEY_CLIENT_SECRET) are not configured on the server.',
      );
    }

    const state = `state_${userId}_${randomBytes(8).toString('hex')}`;
    const authUrl = `https://api.mendeley.com/oauth/authorize?client_id=${encodeURIComponent(
      this.clientId,
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=all&state=${encodeURIComponent(
      state,
    )}`;

    return {
      authUrl,
      state,
    };
  }

  async handleCallback(params: {
    codeOrToken: string;
    verifier?: string;
    state?: string;
    secret?: string;
    redirectUri: string;
  }): Promise<OAuthExchangeResult> {
    if (!this.clientId || !this.clientSecret) {
      throw new BadRequestException(
        'Mendeley OAuth credentials are not configured on the server.',
      );
    }

    try {
      const tokenUrl = 'https://api.mendeley.com/oauth/token';
      const basicAuth = Buffer.from(
        `${this.clientId}:${this.clientSecret}`,
      ).toString('base64');

      const bodyParams = new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.codeOrToken,
        redirect_uri: params.redirectUri,
      });

      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(
          `Mendeley OAuth token exchange failed (${tokenResponse.status}): ${errorText}`,
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      let accountName = 'Mendeley User';
      let accountEmail = 'user@mendeley.com';
      let providerUserId = 'mendeley_profile';

      try {
        const profileResponse = await fetch(
          'https://api.mendeley.com/profiles/me',
          {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              Accept: 'application/vnd.mendeley-profiles.1+json',
            },
          },
        );

        if (profileResponse.ok) {
          const profile = (await profileResponse.json()) as {
            id?: string;
            display_name?: string;
            email?: string;
            first_name?: string;
            last_name?: string;
          };
          providerUserId = profile.id || providerUserId;
          accountName =
            profile.display_name ||
            [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
            accountName;
          accountEmail = profile.email || accountEmail;
        }
      } catch (profileErr: unknown) {
        const errMsg =
          profileErr instanceof Error ? profileErr.message : String(profileErr);
        this.logger.warn(
          `Could not retrieve Mendeley profile details: ${errMsg}`,
        );
      }

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresInSeconds: tokenData.expires_in,
        providerUserId,
        accountName,
        accountEmail,
        metadata: {
          provider: 'mendeley',
          accountName,
        },
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error exchanging Mendeley token: ${errMsg}`, stack);
      throw err;
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthExchangeResult> {
    if (!this.clientId || !this.clientSecret) {
      throw new BadRequestException(
        'Mendeley OAuth credentials are not configured on the server.',
      );
    }

    try {
      const tokenUrl = 'https://api.mendeley.com/oauth/token';
      const basicAuth = Buffer.from(
        `${this.clientId}:${this.clientSecret}`,
      ).toString('base64');

      const bodyParams = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      const tokenResponse = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw new Error(
          `Failed to refresh Mendeley token: ${tokenResponse.status} ${errorText}`,
        );
      }

      const tokenData = (await tokenResponse.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
        refresh_token?: string;
      };

      return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        expiresInSeconds: tokenData.expires_in,
        providerUserId: '',
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error refreshing Mendeley token: ${errMsg}`);
      throw err;
    }
  }

  async fetchCollections(
    decryptedToken: string,
    _providerUserId: string,
  ): Promise<RemoteCollectionItem[]> {
    try {
      const url = 'https://api.mendeley.com/folders?limit=100';
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${decryptedToken}`,
          Accept: 'application/vnd.mendeley-folder.1+json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Mendeley folders: status ${response.status}`,
        );
      }

      const folders = (await response.json()) as Array<{
        id: string;
        name: string;
        parent_id?: string | null;
        total_documents?: number;
      }>;

      return folders.map((folder) => ({
        id: folder.id,
        name: folder.name || 'Untitled Folder',
        itemCount: folder.total_documents || 0,
        parentCollectionId: folder.parent_id || null,
      }));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error fetching Mendeley folders: ${errMsg}`, stack);
      throw err;
    }
  }

  async fetchCollectionBibtex(
    decryptedToken: string,
    _providerUserId: string,
    collectionId: string,
  ): Promise<string> {
    try {
      const bibtexUrl = `https://api.mendeley.com/documents?folder_id=${encodeURIComponent(
        collectionId,
      )}&view=bib&limit=100`;

      const response = await fetch(bibtexUrl, {
        headers: {
          Authorization: `Bearer ${decryptedToken}`,
          Accept:
            'application/x-bibtex, application/vnd.mendeley-document.1+json',
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Mendeley documents: status ${response.status}`,
        );
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('bibtex')) {
        return await response.text();
      }

      const docs = (await response.json()) as MendeleyDocument[];
      return this.convertDocumentsToBibtex(docs);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      this.logger.error(`Error fetching Mendeley BibTeX: ${errMsg}`, stack);
      throw err;
    }
  }

  private convertDocumentsToBibtex(docs: MendeleyDocument[]): string {
    if (!Array.isArray(docs) || docs.length === 0) {
      return '';
    }

    return docs
      .map((doc) => {
        const type = doc.type === 'book' ? 'book' : 'article';
        const firstAuthor =
          doc.authors?.[0]?.last_name
            ?.toLowerCase()
            .replace(/[^a-z0-9]/g, '') || 'author';
        const year = doc.year || 'nodate';
        const titleWord = (doc.title || 'untitled')
          .split(/\s+/)[0]
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '');
        const citationKey = `${firstAuthor}${year}${titleWord}`;

        const authors =
          doc.authors
            ?.map((a) => [a.last_name, a.first_name].filter(Boolean).join(', '))
            .join(' and ') || 'Unknown Author';

        const lines: string[] = [`@${type}{${citationKey},`];
        if (doc.title) lines.push(`  title = {${doc.title}},`);
        lines.push(`  author = {${authors}},`);
        if (doc.source) lines.push(`  journal = {${doc.source}},`);
        if (doc.year) lines.push(`  year = {${doc.year}},`);
        if (doc.volume) lines.push(`  volume = {${doc.volume}},`);
        if (doc.issue) lines.push(`  number = {${doc.issue}},`);
        if (doc.pages) lines.push(`  pages = {${doc.pages}},`);
        if (doc.publisher) lines.push(`  publisher = {${doc.publisher}},`);
        if (doc.identifiers?.doi)
          lines.push(`  doi = {${doc.identifiers.doi}},`);
        lines.push('}');

        return lines.join('\n');
      })
      .join('\n\n');
  }
}
