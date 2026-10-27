/**
 * modules/manuscripts/core/ports/live-collaboration.port.ts
 *
 * Shared Kernel contract through which Docstore and external manuscript modules
 * interact with the live real-time collaboration layer (Yjs sessions + socket presence).
 */

export interface LivePresenceUser {
  id: string;
  userId: string;
  name: string;
  color: string;
  avatar: string | null;
  fileId: string | null;
  cursor: Record<string, unknown> | null;
  lastSeen: number;
}

export abstract class LiveCollaborationPort {
  /**
   * Pushes externally-written full text into the live Y.Doc session (if one is
   * open) and broadcasts the CRDT update to connected peers.
   * @returns true when a live session existed and was updated.
   */
  abstract applyExternalText(
    projectId: string,
    docId: string,
    text: string,
  ): Promise<boolean>;

  /** Users connected over WebSocket to the document (or the whole project if docId is null). */
  abstract getPresence(
    projectId: string,
    docId: string | null,
  ): Promise<LivePresenceUser[]>;

  /**
   * Flushes in-memory live sessions for the given docs to Docstore.
   * @returns ids of docs that had an active live session and were flushed.
   */
  abstract flushDocs(projectId: string, docIds: string[]): Promise<string[]>;

  /**
   * Flushes a single in-memory live session for the given doc to Docstore.
   */
  flushDoc(projectId: string, docId: string): Promise<string[]> {
    return this.flushDocs(projectId, [docId]);
  }

  /**
   * Immediately terminates any active in-memory Yjs session for a deleted document,
   * cancelling pending debounce timers so deleted documents are never re-flushed to Postgres.
   */
  abstract evictDoc(projectId: string, docId: string): Promise<void>;
}

/**
 * Null Object Pattern implementation of `LiveCollaborationPort`.
 * Safely absorbs live collaboration calls when the WebSocket gateway is not mounted
 * (e.g. CLI tools, isolated unit tests, or background workers), eliminating
 * scattered `this.moduleRef?.get(LiveCollaborationPort, { strict: false })` lookups
 * and null checks across services.
 */
export class NoopLiveCollaborationAdapter extends LiveCollaborationPort {
  public readonly isNoop = true;

  public async applyExternalText(
    _projectId: string,
    _docId: string,
    _text: string,
  ): Promise<boolean> {
    return false;
  }

  public async getPresence(
    _projectId: string,
    _docId: string | null,
  ): Promise<LivePresenceUser[]> {
    return [];
  }

  public async flushDocs(
    _projectId: string,
    _docIds: string[],
  ): Promise<string[]> {
    return [];
  }

  public async evictDoc(_projectId: string, _docId: string): Promise<void> {
    return;
  }
}

export const NOOP_LIVE_COLLABORATION = new NoopLiveCollaborationAdapter();

export const LIVE_COLLABORATION_PORT = LiveCollaborationPort;
