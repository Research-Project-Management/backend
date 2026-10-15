/**
 * modules/manuscripts/docstore/domain/live-collaboration.port.ts
 *
 * Clean interface through which Docstore and external modules interact with
 * the live real-time collaboration layer (Yjs sessions + socket presence).
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
}
