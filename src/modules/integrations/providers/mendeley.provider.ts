import { Injectable, Logger } from '@nestjs/common';
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
  private readonly isMockMode: boolean;

  constructor() {
    this.clientId = process.env.MENDELEY_CLIENT_ID || '';
    this.clientSecret = process.env.MENDELEY_CLIENT_SECRET || '';
    this.isMockMode = !this.clientId || !this.clientSecret;

    if (this.isMockMode) {
      this.logger.warn(
        'Mendeley client credentials not configured. Operating in development mock/sandbox mode.',
      );
    }
  }

  async initiateOAuth(
    userId: string,
    redirectUri: string,
  ): Promise<OAuthInitiationResult> {
    const state = `state_${userId}_${randomBytes(8).toString('hex')}`;

    if (this.isMockMode) {
      const mockCode = `mock_code_${randomBytes(8).toString('hex')}`;
      const mockAuthUrl = `${redirectUri}?code=${mockCode}&state=${state}`;
      return {
        authUrl: mockAuthUrl,
        state,
      };
    }

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
    if (this.isMockMode || params.codeOrToken.startsWith('mock_')) {
      return {
        accessToken: `mendeley_mock_token_${randomBytes(16).toString('hex')}`,
        refreshToken: `mendeley_mock_refresh_${randomBytes(16).toString('hex')}`,
        expiresInSeconds: 3600,
        providerUserId: 'mendeley_user_883921',
        accountName: 'Mendeley Researcher (Sandbox)',
        accountEmail: 'researcher@mendeley.sandbox',
        metadata: { isMock: true, provider: 'mendeley' },
      };
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

      // Fetch user profile from Mendeley
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
      } catch (profileErr: any) {
        this.logger.warn(
          `Could not retrieve Mendeley profile details: ${profileErr.message}`,
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
    } catch (err: any) {
      this.logger.error(
        `Error exchanging Mendeley token: ${err.message}`,
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
        { id: 'mendeley_f1', name: 'Thesis Literature Review', itemCount: 18 },
        {
          id: 'mendeley_f2',
          name: 'Biomedical Imaging & Deep Learning',
          itemCount: 32,
        },
        { id: 'mendeley_f3', name: 'Journal Draft 2026', itemCount: 7 },
      ];
    }

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
    } catch (err: any) {
      this.logger.error(
        `Error fetching Mendeley folders: ${err.message}`,
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
      return `@article{he2016deep,
  title={Deep residual learning for image recognition},
  author={He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},
  journal={Proceedings of the IEEE conference on computer vision and pattern recognition},
  pages={770--778},
  year={2016}
}

@article{ronneberger2015u,
  title={U-net: Convolutional networks for biomedical image segmentation},
  author={Ronneberger, Olaf and Fischer, Philipp and Brox, Thomas},
  journal={Medical image computing and computer-assisted intervention},
  pages={234--241},
  year={2015},
  publisher={Springer}
}`;
    }

    try {
      // First attempt: fetch directly as BibTeX
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

      // If returned as JSON documents, parse and format as BibTeX
      const docs = (await response.json()) as MendeleyDocument[];
      return this.convertDocumentsToBibtex(docs);
    } catch (err: any) {
      this.logger.error(
        `Error fetching Mendeley BibTeX: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  private convertDocumentsToBibtex(docs: MendeleyDocument[]): string {
    if (!Array.isArray(docs) || docs.length === 0) {
      return '% Empty Mendeley collection\n';
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
