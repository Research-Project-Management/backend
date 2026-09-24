/**
 * realtime/core/domain/value-objects/client-update-payload.vo.ts
 * Value Object validating incoming client keystroke update ops (lines or splices).
 */

export interface LineSplice {
  startLine: number;
  deleteCount: number;
  newLines: string[];
}

export interface ClientUpdatePayloadProps {
  projectId: string;
  docId: string;
  clientRev: number;
  lines?: string[] | null;
  splice?: LineSplice | null;
  userId?: string | null;
  debounceMs?: number;
}

export class ClientUpdatePayloadVo {
  public readonly projectId: string;
  public readonly docId: string;
  public readonly clientRev: number;
  public readonly lines: string[] | null;
  public readonly splice: LineSplice | null;
  public readonly userId: string | null;
  public readonly debounceMs: number;

  private constructor(props: ClientUpdatePayloadProps) {
    if (!props.projectId || !props.projectId.trim()) {
      throw new Error('Project ID cannot be empty.');
    }
    if (!props.docId || !props.docId.trim()) {
      throw new Error('Document ID cannot be empty.');
    }
    if (props.clientRev < 0) {
      throw new Error('Client revision cannot be negative.');
    }
    if (!props.lines && !props.splice) {
      throw new Error('Either lines or splice operation must be provided.');
    }

    this.projectId = props.projectId;
    this.docId = props.docId;
    this.clientRev = props.clientRev;
    this.lines = props.lines ? [...props.lines] : null;
    this.splice = props.splice
      ? {
          startLine: Math.max(0, props.splice.startLine),
          deleteCount: Math.max(0, props.splice.deleteCount),
          newLines: [...props.splice.newLines],
        }
      : null;
    this.userId = props.userId ?? null;
    this.debounceMs = props.debounceMs ?? 1500;
  }

  public static create(props: ClientUpdatePayloadProps): ClientUpdatePayloadVo {
    return new ClientUpdatePayloadVo(props);
  }

  public isSplice(): boolean {
    return this.splice !== null;
  }

  public isFullReplacement(): boolean {
    return this.lines !== null && this.splice === null;
  }
}
