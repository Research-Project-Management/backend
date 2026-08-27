import { Injectable, Logger } from '@nestjs/common';

export interface RemoteLibrary {
  id: string;
  type: 'user' | 'group';
  name: string;
  version?: number;
  numItems?: number;
}

export interface ZoteroFetchOptions {
  sinceVersion?: bigint;
  limit?: number;
  start?: number;
  itemType?: string;
}

export interface ZoteroPullItemsResult {
  items: any[];
  version: bigint;
  totalResults: number;
}

export interface ZoteroPullCollectionsResult {
  collections: any[];
  version: bigint;
}

export interface ZoteroPullDeletedResult {
  items: string[];
  collections: string[];
  searches: string[];
  version: bigint;
}

@Injectable()
export class ZoteroConnector {
  private readonly logger = new Logger(ZoteroConnector.name);
  private readonly baseUrl = 'https://api.zotero.org';

  /**
   * Validates a Zotero API key by testing the key endpoint.
   */
  async validateApiKey(
    apiKey: string,
  ): Promise<{ valid: boolean; userId?: string; username?: string }> {
    try {
      const res = await this.executeFetch('/keys/current', apiKey);
      if (!res.ok) {
        return { valid: false };
      }
      const data = await res.json();
      return {
        valid: true,
        userId: data.userID ? String(data.userID) : undefined,
        username: data.username,
      };
    } catch (err: any) {
      this.logger.warn(`Zotero API key validation failed: ${err.message}`);
      return { valid: false };
    }
  }

  /**
   * Lists remote libraries accessible with the given API key.
   */
  async listLibraries(
    apiKey: string,
    userId: string,
  ): Promise<RemoteLibrary[]> {
    const libraries: RemoteLibrary[] = [
      {
        id: userId,
        type: 'user',
        name: 'My Library (Personal)',
      },
    ];

    try {
      const res = await this.executeFetch(`/users/${userId}/groups`, apiKey);
      if (res.ok) {
        const groups = await res.json();
        for (const g of groups) {
          libraries.push({
            id: String(g.id),
            type: 'group',
            name: g.data?.name || `Group ${g.id}`,
            numItems: g.meta?.numItems,
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to fetch Zotero groups: ${err.message}`);
    }

    return libraries;
  }

  /**
   * Pulls items from Zotero with cursor-based pagination and Last-Modified-Version tracking.
   */
  async pullItems(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    options: ZoteroFetchOptions = {},
  ): Promise<ZoteroPullItemsResult> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;
    const query = new URLSearchParams();

    const limit = Math.min(options.limit ?? 50, 100);
    query.set('limit', String(limit));

    if (options.start) {
      query.set('start', String(options.start));
    }
    if (options.sinceVersion && options.sinceVersion > BigInt(0)) {
      query.set('since', String(options.sinceVersion));
    }
    if (options.itemType) {
      query.set('itemType', options.itemType);
    }

    const endpoint = `${prefix}/items?${query.toString()}`;
    const res = await this.executeFetch(endpoint, apiKey);

    if (!res.ok) {
      throw new Error(
        `Zotero pull items failed (${res.status}): ${res.statusText}`,
      );
    }

    const versionHeader = res.headers.get('Last-Modified-Version');
    const totalResultsHeader = res.headers.get('Total-Results');

    const version = versionHeader ? BigInt(versionHeader) : BigInt(0);
    const totalResults = totalResultsHeader
      ? parseInt(totalResultsHeader, 10)
      : 0;
    const items = await res.json();

    return {
      items: Array.isArray(items) ? items : [],
      version,
      totalResults,
    };
  }

  /**
   * Pulls collections from Zotero.
   */
  async pullCollections(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    sinceVersion?: bigint,
  ): Promise<ZoteroPullCollectionsResult> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;
    const query = new URLSearchParams();
    query.set('limit', '100');

    if (sinceVersion && sinceVersion > BigInt(0)) {
      query.set('since', String(sinceVersion));
    }

    const endpoint = `${prefix}/collections?${query.toString()}`;
    const res = await this.executeFetch(endpoint, apiKey);

    if (!res.ok) {
      throw new Error(
        `Zotero pull collections failed (${res.status}): ${res.statusText}`,
      );
    }

    const versionHeader = res.headers.get('Last-Modified-Version');
    const version = versionHeader ? BigInt(versionHeader) : BigInt(0);
    const collections = await res.json();

    return {
      collections: Array.isArray(collections) ? collections : [],
      version,
    };
  }

  /**
   * Pulls deleted keys from Zotero since a given version.
   */
  async pullDeleted(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    sinceVersion: bigint,
  ): Promise<ZoteroPullDeletedResult> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;
    const query = new URLSearchParams();
    query.set('since', String(sinceVersion));

    const endpoint = `${prefix}/deleted?${query.toString()}`;
    const res = await this.executeFetch(endpoint, apiKey);

    if (!res.ok) {
      throw new Error(
        `Zotero pull deleted failed (${res.status}): ${res.statusText}`,
      );
    }

    const versionHeader = res.headers.get('Last-Modified-Version');
    const version = versionHeader ? BigInt(versionHeader) : BigInt(0);
    const data = await res.json();

    return {
      items: Array.isArray(data?.items) ? data.items : [],
      collections: Array.isArray(data?.collections) ? data.collections : [],
      searches: Array.isArray(data?.searches) ? data.searches : [],
      version,
    };
  }

  /**
   * Pushes a new or updated item to Zotero with remote version precondition (If-Unmodified-Since-Version)
   * and idempotent write-token protection.
   */
  async pushItem(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    itemPayload: Record<string, any>,
    remoteKey?: string,
    remoteVersion?: bigint,
    writeToken?: string,
  ): Promise<{
    success: boolean;
    key: string;
    version: bigint;
    conflict?: boolean;
    preconditionRequired?: boolean;
    errorMessage?: string;
  }> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;

    const effectiveWriteToken =
      writeToken ||
      `flux-wt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    if (remoteKey) {
      // Update existing item
      const endpoint = `${prefix}/items/${remoteKey}`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Zotero-Write-Token': effectiveWriteToken,
      };
      if (remoteVersion && remoteVersion > BigInt(0)) {
        headers['If-Unmodified-Since-Version'] = String(remoteVersion);
      }

      const res = await this.executeFetch(endpoint, apiKey, {
        method: 'PUT',
        headers,
        body: JSON.stringify(itemPayload),
      });

      if (res.status === 412) {
        // Precondition failed -> Remote version mismatch / mid-air collision!
        return {
          success: false,
          key: remoteKey,
          version: remoteVersion || BigInt(0),
          conflict: true,
        };
      }

      if (res.status === 428) {
        // Precondition Required -> Missing version header on versioned library
        return {
          success: false,
          key: remoteKey,
          version: remoteVersion || BigInt(0),
          preconditionRequired: true,
          errorMessage: 'Zotero precondition required (missing version header)',
        };
      }

      if (!res.ok) {
        throw new Error(
          `Zotero push item update failed (${res.status}): ${res.statusText}`,
        );
      }

      const versionHeader = res.headers.get('Last-Modified-Version');
      const version = versionHeader
        ? BigInt(versionHeader)
        : remoteVersion || BigInt(0);

      return {
        success: true,
        key: remoteKey,
        version,
      };
    } else {
      // Create new remote item with Zotero-Write-Token
      const endpoint = `${prefix}/items`;
      const res = await this.executeFetch(endpoint, apiKey, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Zotero-Write-Token': effectiveWriteToken,
        },
        body: JSON.stringify([itemPayload]),
      });

      if (res.status === 412) {
        return {
          success: false,
          key: '',
          version: BigInt(0),
          conflict: true,
        };
      }

      if (!res.ok) {
        throw new Error(
          `Zotero push item create failed (${res.status}): ${res.statusText}`,
        );
      }

      const versionHeader = res.headers.get('Last-Modified-Version');
      const version = versionHeader ? BigInt(versionHeader) : BigInt(1);
      const data = await res.json();

      // Check if failed map has errors
      if (data?.failed && Object.keys(data.failed).length > 0) {
        const failureEntry = Object.values(data.failed)[0] as any;
        throw new Error(
          `Zotero rejected item creation: ${failureEntry?.message || 'Unknown write failure'} (code ${failureEntry?.code})`,
        );
      }

      const createdKey =
        data?.successful?.['0']?.key ||
        (Object.values(data?.successful || {})[0] as any)?.key ||
        (Object.values(data?.unchanged || {})[0] as any)?.key ||
        '';

      if (!createdKey) {
        throw new Error(
          'Zotero item creation succeeded but no valid remote key was returned in response',
        );
      }

      return {
        success: true,
        key: createdKey,
        version,
      };
    }
  }

  /**
   * Deletes a remote item on Zotero with version precondition.
   */
  async deleteItemRemote(
    apiKey: string,
    libraryType: 'user' | 'group',
    libraryId: string,
    remoteKey: string,
    remoteVersion?: bigint,
  ): Promise<{
    success: boolean;
    conflict?: boolean;
    preconditionRequired?: boolean;
  }> {
    const prefix =
      libraryType === 'user' ? `/users/${libraryId}` : `/groups/${libraryId}`;
    const endpoint = `${prefix}/items/${remoteKey}`;

    const headers: Record<string, string> = {};
    if (remoteVersion && remoteVersion > BigInt(0)) {
      headers['If-Unmodified-Since-Version'] = String(remoteVersion);
    }

    const res = await this.executeFetch(endpoint, apiKey, {
      method: 'DELETE',
      headers,
    });

    if (res.status === 412) {
      return { success: false, conflict: true };
    }

    if (res.status === 428) {
      return { success: false, preconditionRequired: true };
    }

    // 404 is treated as idempotent success (already deleted)
    if (res.status === 404) {
      return { success: true };
    }

    if (!res.ok) {
      throw new Error(
        `Zotero delete item remote failed (${res.status}): ${res.statusText}`,
      );
    }

    return { success: true };
  }

  /**
   * Internal fetch wrapper with rate-limiting, Retry-After header respect, and backoff.
   */
  protected async executeFetch(
    endpoint: string,
    apiKey: string,
    options: RequestInit = {},
    attempt = 1,
  ): Promise<Response> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${this.baseUrl}${endpoint}`;

    const headers = new Headers(options.headers || {});
    headers.set('Zotero-API-Version', '3');
    headers.set('Zotero-API-Key', apiKey);

    const maxAttempts = 3;

    try {
      const res = await fetch(url, {
        ...options,
        headers,
      });

      // Handle rate limit (429 Too Many Requests)
      if (res.status === 429 && attempt <= maxAttempts) {
        const retryAfterHeader =
          res.headers.get('Retry-After') || res.headers.get('Backoff');
        const retrySeconds = retryAfterHeader
          ? parseInt(retryAfterHeader, 10)
          : Math.pow(2, attempt);
        const waitMs = Math.min(Math.max(retrySeconds * 1000, 1000), 10000);

        this.logger.warn(
          `Zotero rate limited (429). Retrying after ${waitMs}ms (attempt ${attempt}/${maxAttempts})`,
        );

        await new Promise((resolve) => setTimeout(resolve, waitMs));
        return this.executeFetch(endpoint, apiKey, options, attempt + 1);
      }

      return res;
    } catch (err: any) {
      if (attempt < maxAttempts) {
        const backoffMs = Math.pow(2, attempt) * 500;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        return this.executeFetch(endpoint, apiKey, options, attempt + 1);
      }
      throw err;
    }
  }
}
