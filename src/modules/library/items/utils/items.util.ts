export interface ICatalogExtraBatchStore {
  getAnnotationsBatch(itemIds: string[]): Promise<Map<string, any[]>>;
  getRelationsBatch(itemIds: string[]): Promise<Map<string, any[]>>;
}

export class CursorUtil {
  static encode(id: string, timestamp?: Date | string | number): string {
    const ts = timestamp ? new Date(timestamp).getTime() : 0;
    return Buffer.from(`${id}:${ts}`).toString('base64url');
  }

  static decode(cursor: string): { id: string; timestamp: number } | null {
    try {
      if (!cursor || typeof cursor !== 'string') return null;
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;

      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      const parts = decoded.split(':');
      if (parts.length !== 2) return null;

      const [id, tsStr] = parts;
      const ts = Number(tsStr);
      if (!id || isNaN(ts) || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;

      return { id, timestamp: ts };
    } catch {
      return null;
    }
  }
}
