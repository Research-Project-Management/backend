import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import {
  IIntegrationProvider,
  IntegrationProviderType,
  OAuthExchangeResult,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './integration-provider.interface';

interface GitHubRepoItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description?: string;
  default_branch: string;
  stargazers_count: number;
  owner?: {
    login: string;
    avatar_url?: string;
  };
}

@Injectable()
export class GithubProvider implements IIntegrationProvider {
  readonly provider: IntegrationProviderType = 'github';
  private readonly logger = new Logger(GithubProvider.name);

  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly isMockMode: boolean;

  constructor() {
    this.clientId =
      process.env.GITHUB_INTEGRATION_CLIENT_ID ||
      process.env.GITHUB_CLIENT_ID ||
      '';
    this.clientSecret =
      process.env.GITHUB_INTEGRATION_CLIENT_SECRET ||
      process.env.GITHUB_CLIENT_SECRET ||
      '';
    this.isMockMode = !this.clientId || !this.clientSecret;

    if (this.isMockMode) {
      this.logger.warn(
        'GitHub client credentials not configured for repository sync. Operating in development mock/sandbox mode.',
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

    const scope = 'repo,read:user,user:email';
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
      this.clientId,
    )}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(
      scope,
    )}&state=${encodeURIComponent(state)}`;

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
        accessToken: `github_mock_pat_${randomBytes(16).toString('hex')}`,
        providerUserId: 'github_user_441928',
        accountName: 'octocat',
        accountEmail: 'octocat@github.sandbox',
        metadata: {
          isMock: true,
          provider: 'github',
          username: 'octocat',
          avatarUrl: 'https://avatars.githubusercontent.com/u/583231',
          scope: 'repo,read:user,user:email',
        },
      };
    }

    // Exchange authorization code for access token
    const tokenRes = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'FluxResearchPlatform/1.0',
        },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code: params.codeOrToken,
          redirect_uri: params.redirectUri,
        }),
      },
    );

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(
        `GitHub token exchange failed: HTTP ${tokenRes.status} ${errText}`,
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      throw new Error(
        tokenData.error_description ||
          tokenData.error ||
          'Failed to obtain access token from GitHub',
      );
    }

    // Fetch GitHub User Profile
    const profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'FluxResearchPlatform/1.0',
      },
    });

    if (!profileRes.ok) {
      const errText = await profileRes.text();
      throw new Error(
        `Failed to fetch GitHub profile: HTTP ${profileRes.status} ${errText}`,
      );
    }

    const profile = (await profileRes.json()) as {
      id: number;
      login: string;
      name?: string;
      email?: string;
      avatar_url?: string;
      html_url?: string;
    };

    let userEmail = profile.email;
    if (!userEmail) {
      try {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'FluxResearchPlatform/1.0',
          },
        });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{
            email: string;
            primary: boolean;
          }>;
          if (Array.isArray(emails) && emails.length > 0) {
            const primary = emails.find((e) => e.primary);
            userEmail = primary?.email || emails[0]?.email;
          }
        }
      } catch (err: any) {
        this.logger.debug(
          `Could not retrieve private email list: ${err.message}`,
        );
      }
    }

    return {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresInSeconds: tokenData.expires_in,
      providerUserId: String(profile.id),
      accountName: profile.login,
      accountEmail: userEmail || `${profile.login}@users.noreply.github.com`,
      metadata: {
        username: profile.login,
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url,
        htmlUrl: profile.html_url,
        scope: tokenData.scope,
      },
    };
  }

  async fetchCollections(
    decryptedToken: string,
    _providerUserId: string,
  ): Promise<RemoteCollectionItem[]> {
    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      return [
        {
          id: 'octocat/research-manuscript',
          name: 'octocat/research-manuscript',
          itemCount: 4,
          parentCollectionId: 'octocat',
        },
        {
          id: 'octocat/quantum-computing-paper',
          name: 'octocat/quantum-computing-paper',
          itemCount: 15,
          parentCollectionId: 'octocat',
        },
        {
          id: 'flux-study/latex-templates',
          name: 'flux-study/latex-templates',
          itemCount: 42,
          parentCollectionId: 'flux-study',
        },
      ];
    }

    const reposRes = await fetch(
      'https://api.github.com/user/repos?per_page=100&sort=updated&type=all',
      {
        headers: {
          Authorization: `Bearer ${decryptedToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'FluxResearchPlatform/1.0',
        },
      },
    );

    if (!reposRes.ok) {
      const errText = await reposRes.text();
      throw new Error(
        `Failed to list GitHub repositories: HTTP ${reposRes.status} ${errText}`,
      );
    }

    const repos = (await reposRes.json()) as GitHubRepoItem[];
    if (!Array.isArray(repos)) {
      return [];
    }

    return repos.map((repo) => ({
      id: repo.full_name,
      name: repo.full_name,
      itemCount: repo.stargazers_count ?? 0,
      parentCollectionId: repo.owner?.login || null,
    }));
  }

  async fetchCollectionBibtex(
    decryptedToken: string,
    _providerUserId: string,
    collectionId: string,
  ): Promise<string> {
    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      return `@article{octocat2026flux,
  title = {Collaborative LaTeX Engineering with Flux and GitHub},
  author = {Octocat, Mona and Flux Team},
  journal = {Journal of Modern Scientific Publishing},
  year = {2026},
  volume = {12},
  pages = {101--125}
}`;
    }

    try {
      const contentsRes = await fetch(
        `https://api.github.com/repos/${collectionId}/contents/`,
        {
          headers: {
            Authorization: `Bearer ${decryptedToken}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'FluxResearchPlatform/1.0',
          },
        },
      );

      if (contentsRes.ok) {
        const contents = (await contentsRes.json()) as Array<{
          name: string;
          download_url?: string;
          type: string;
        }>;

        if (Array.isArray(contents)) {
          const bibFile = contents.find(
            (c) => c.type === 'file' && c.name.toLowerCase().endsWith('.bib'),
          );
          if (bibFile && bibFile.download_url) {
            const rawRes = await fetch(bibFile.download_url, {
              headers: {
                Authorization: `Bearer ${decryptedToken}`,
                'User-Agent': 'FluxResearchPlatform/1.0',
              },
            });
            if (rawRes.ok) {
              return await rawRes.text();
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not fetch bibtex from ${collectionId}: ${err.message}`,
      );
    }

    return `% GitHub Repository: ${collectionId}\n% Synced with Flux LaTeX Platform\n`;
  }

  async listBranches(
    decryptedToken: string,
    repoFullName: string,
  ): Promise<string[]> {
    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      return ['main', 'dev', 'paper-revisions'];
    }

    const branchesRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/branches?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${decryptedToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'FluxResearchPlatform/1.0',
        },
      },
    );

    if (!branchesRes.ok) {
      const errText = await branchesRes.text();
      throw new Error(
        `Failed to list branches for ${repoFullName}: HTTP ${branchesRes.status} ${errText}`,
      );
    }

    const branches = (await branchesRes.json()) as Array<{ name: string }>;
    return branches.map((b) => b.name);
  }

  async createRepository(
    decryptedToken: string,
    name: string,
    isPrivate = true,
    description?: string,
  ): Promise<{ fullName: string; htmlUrl: string; defaultBranch: string }> {
    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      return {
        fullName: `octocat/${name}`,
        htmlUrl: `https://github.com/octocat/${name}`,
        defaultBranch: 'main',
      };
    }

    const res = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${decryptedToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'FluxResearchPlatform/1.0',
      },
      body: JSON.stringify({
        name,
        private: isPrivate,
        description:
          description || 'Created from Flux LaTeX Manuscript Platform',
        auto_init: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Failed to create GitHub repository ${name}: HTTP ${res.status} ${errText}`,
      );
    }

    const data = (await res.json()) as GitHubRepoItem;
    return {
      fullName: data.full_name,
      htmlUrl: data.html_url,
      defaultBranch: data.default_branch || 'main',
    };
  }

  async pushProjectTree(params: {
    decryptedToken: string;
    repoFullName: string;
    branch?: string;
    files: Array<{ path: string; data: Buffer }>;
    commitMessage?: string;
    author?: { name: string; email: string };
  }): Promise<{ commitSha: string; commitUrl: string }> {
    const { decryptedToken, repoFullName, files } = params;
    const branch = params.branch || 'main';
    const commitMessage =
      params.commitMessage || 'Update manuscript from Flux LaTeX Platform';

    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      const mockSha = `commit_${randomBytes(10).toString('hex')}`;
      return {
        commitSha: mockSha,
        commitUrl: `https://github.com/${repoFullName}/commit/${mockSha}`,
      };
    }

    const headers = {
      Authorization: `Bearer ${decryptedToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'FluxResearchPlatform/1.0',
    };

    // 1. Get current branch reference
    const refRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${branch}`,
      { headers },
    );

    let latestCommitSha: string;
    if (refRes.ok) {
      const refData = (await refRes.json()) as { object: { sha: string } };
      latestCommitSha = refData.object.sha;
    } else {
      // Check repository default branch if target branch ref not found
      const repoRes = await fetch(
        `https://api.github.com/repos/${repoFullName}`,
        { headers },
      );
      if (!repoRes.ok) {
        throw new Error(
          `Failed to inspect repository ${repoFullName}: HTTP ${repoRes.status}`,
        );
      }
      const repoData = (await repoRes.json()) as { default_branch: string };
      const defaultBranch = repoData.default_branch || 'main';

      const defaultRefRes = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/ref/heads/${defaultBranch}`,
        { headers },
      );
      if (!defaultRefRes.ok) {
        throw new Error(
          `Cannot determine base commit for ${repoFullName}. Ensure the repository is initialized with at least one commit.`,
        );
      }
      const defaultRefData = (await defaultRefRes.json()) as {
        object: { sha: string };
      };
      latestCommitSha = defaultRefData.object.sha;

      // Create new branch pointer from default branch
      if (branch !== defaultBranch) {
        const createRefRes = await fetch(
          `https://api.github.com/repos/${repoFullName}/git/refs`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: latestCommitSha,
            }),
          },
        );
        if (!createRefRes.ok) {
          const errText = await createRefRes.text();
          throw new Error(
            `Failed to create branch ${branch}: HTTP ${createRefRes.status} ${errText}`,
          );
        }
      }
    }

    // 2. Get latest commit to find base_tree
    const commitRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`,
      { headers },
    );
    if (!commitRes.ok) {
      throw new Error(
        `Failed to fetch base commit ${latestCommitSha}: HTTP ${commitRes.status}`,
      );
    }
    const commitData = (await commitRes.json()) as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // 3. Upload blobs for all files
    const treeEntries: Array<{
      path: string;
      mode: '100644';
      type: 'blob';
      sha: string;
    }> = [];

    for (const file of files) {
      const cleanPath = file.path.replace(/^\/+/, '');
      if (!cleanPath || cleanPath.startsWith('.git/')) continue;

      const base64Content = file.data.toString('base64');
      const blobRes = await fetch(
        `https://api.github.com/repos/${repoFullName}/git/blobs`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            content: base64Content,
            encoding: 'base64',
          }),
        },
      );

      if (!blobRes.ok) {
        const errText = await blobRes.text();
        throw new Error(
          `Failed to upload blob for ${cleanPath}: HTTP ${blobRes.status} ${errText}`,
        );
      }

      const blobData = (await blobRes.json()) as { sha: string };
      treeEntries.push({
        path: cleanPath,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha,
      });
    }

    // 4. Create new Git Tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeEntries,
        }),
      },
    );

    if (!treeRes.ok) {
      const errText = await treeRes.text();
      throw new Error(
        `Failed to create Git tree for ${repoFullName}: HTTP ${treeRes.status} ${errText}`,
      );
    }
    const newTreeData = (await treeRes.json()) as { sha: string };

    // 5. Create new Git Commit
    const commitPayload: Record<string, unknown> = {
      message: commitMessage,
      tree: newTreeData.sha,
      parents: [latestCommitSha],
    };
    if (params.author) {
      commitPayload.author = {
        name: params.author.name,
        email: params.author.email,
        date: new Date().toISOString(),
      };
    }

    const newCommitRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(commitPayload),
      },
    );

    if (!newCommitRes.ok) {
      const errText = await newCommitRes.text();
      throw new Error(
        `Failed to create Git commit: HTTP ${newCommitRes.status} ${errText}`,
      );
    }
    const newCommit = (await newCommitRes.json()) as {
      sha: string;
      html_url?: string;
    };

    // 6. Update reference heads to point to new commit
    const updateRefRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/${branch}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          sha: newCommit.sha,
          force: false,
        }),
      },
    );

    if (!updateRefRes.ok) {
      const errText = await updateRefRes.text();
      throw new Error(
        `Failed to advance branch ${branch} to ${newCommit.sha}: HTTP ${updateRefRes.status} ${errText}`,
      );
    }

    return {
      commitSha: newCommit.sha,
      commitUrl:
        newCommit.html_url ||
        `https://github.com/${repoFullName}/commit/${newCommit.sha}`,
    };
  }

  async pullProjectTree(params: {
    decryptedToken: string;
    repoFullName: string;
    branch?: string;
  }): Promise<Array<{ path: string; data: Buffer }>> {
    const { decryptedToken, repoFullName } = params;
    const branch = params.branch || 'main';

    if (this.isMockMode || decryptedToken.startsWith('github_mock_')) {
      return [
        {
          path: 'main.tex',
          data: Buffer.from(
            `\\documentclass{article}\n\\usepackage[utf8]{inputenc}\n\\title{Synced from GitHub}\n\\author{Octocat}\n\\begin{document}\n\\maketitle\n\\section{Introduction}\nThis manuscript was pulled directly from GitHub (${repoFullName}).\n\\end{document}\n`,
            'utf8',
          ),
        },
        {
          path: 'references.bib',
          data: Buffer.from(
            `@article{pulled2026,\n  title={Pulled from ${repoFullName}},\n  author={Octocat},\n  year={2026}\n}\n`,
            'utf8',
          ),
        },
      ];
    }

    const headers = {
      Authorization: `Bearer ${decryptedToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'FluxResearchPlatform/1.0',
    };

    // 1. Get branch head commit
    const refRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/${branch}`,
      { headers },
    );
    if (!refRes.ok) {
      throw new Error(
        `Failed to find branch ${branch} on ${repoFullName}: HTTP ${refRes.status}`,
      );
    }
    const refData = (await refRes.json()) as { object: { sha: string } };
    const latestCommitSha = refData.object.sha;

    // 2. Get commit tree
    const commitRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/commits/${latestCommitSha}`,
      { headers },
    );
    if (!commitRes.ok) {
      throw new Error(
        `Failed to inspect commit ${latestCommitSha}: HTTP ${commitRes.status}`,
      );
    }
    const commitData = (await commitRes.json()) as { tree: { sha: string } };

    // 3. Fetch recursive tree
    const treeRes = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/${commitData.tree.sha}?recursive=1`,
      { headers },
    );
    if (!treeRes.ok) {
      throw new Error(`Failed to fetch tree hierarchy: HTTP ${treeRes.status}`);
    }
    const treeData = (await treeRes.json()) as {
      tree: Array<{ path: string; type: string; sha: string; size?: number }>;
    };

    const pulledFiles: Array<{ path: string; data: Buffer }> = [];

    // Filter blobs only, excluding git metadata and excessively large files
    const blobEntries = (treeData.tree || []).filter(
      (item) => item.type === 'blob' && !item.path.startsWith('.git/'),
    );

    for (const item of blobEntries) {
      try {
        const blobRes = await fetch(
          `https://api.github.com/repos/${repoFullName}/git/blobs/${item.sha}`,
          { headers },
        );
        if (!blobRes.ok) continue;

        const blobJson = (await blobRes.json()) as {
          content: string;
          encoding: string;
        };

        const buffer =
          blobJson.encoding === 'base64'
            ? Buffer.from(blobJson.content, 'base64')
            : Buffer.from(blobJson.content, 'utf8');

        pulledFiles.push({
          path: item.path,
          data: buffer,
        });
      } catch (err: any) {
        this.logger.warn(`Could not pull blob ${item.path}: ${err.message}`);
      }
    }

    return pulledFiles;
  }
}
