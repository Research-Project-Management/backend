import { computeLineDiff } from '@/modules/manuscripts/docstore/core/domain/line-diff';
import {
  buildSearchRegex,
  replaceInText,
} from '@/modules/manuscripts/docstore/core/domain/text-replace';
import { YjsDocManagerAdapter } from '@/modules/realtime/manuscripts/core/adapters/crdt/yjs-doc-manager.adapter';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';

describe('line-diff', () => {
  it('produces real hunks and stats', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
    const b = ['a', 'b', 'X', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
    const r = computeLineDiff(a, b, { from: 'v1', to: 'v2' });
    expect(r.stats).toEqual({ additions: 2, deletions: 1, unchanged: 9 });
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[0].lines).toContain('-c');
    expect(r.hunks[0].lines).toContain('+X');
    expect(r.unified.startsWith('--- v1\n+++ v2\n@@ -1,')).toBe(true);
  });

  it('identical inputs have no hunks', () => {
    const r = computeLineDiff('x\ny', 'x\ny');
    expect(r.hunks).toEqual([]);
    expect(r.stats.unchanged).toBe(2);
  });
});

describe('text-replace', () => {
  it('literal, case-insensitive, does not expand $&', () => {
    expect(replaceInText('Foo foo', 'foo', '$&!')).toEqual({
      text: '$&! $&!',
      count: 2,
    });
  });
  it('whole word', () => {
    expect(
      replaceInText('cat concat cat', 'cat', 'dog', { wholeWord: true }).text,
    ).toBe('dog concat dog');
  });
  it('regex with groups', () => {
    expect(
      replaceInText('a1 b2', '([a-z])(\\d)', '$2$1', { useRegex: true }).text,
    ).toBe('1a 2b');
  });
  it('rejects empty-matching and invalid patterns', () => {
    expect(() => buildSearchRegex('x*', { useRegex: true })).toThrow();
    expect(() => buildSearchRegex('(', { useRegex: true })).toThrow();
  });
});

describe('YjsDocManagerAdapter.replaceTextIfActive', () => {
  it('returns null when no live session', () => {
    const m = new YjsDocManagerAdapter();
    expect(m.replaceTextIfActive('p', 'd', 'x')).toBeNull();
    void m.onModuleDestroy();
  });

  it('splices active doc and returns an update frame peers can apply', async () => {
    const m = new YjsDocManagerAdapter();
    const s = await m.getOrCreateDoc('p', 'd');
    s.yText.insert(0, 'hello world');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(s.doc));

    const frame = m.replaceTextIfActive('p', 'd', 'hello brave world');
    expect(frame).not.toBeNull();
    expect(s.yText.toString()).toBe('hello brave world');

    const dec = decoding.createDecoder(new Uint8Array(frame!));
    decoding.readVarUint(dec); // message type
    Y.applyUpdate(peer, decoding.readVarUint8Array(dec));
    expect(peer.getText('latex').toString()).toBe('hello brave world');

    expect(m.replaceTextIfActive('p', 'd', 'hello brave world')).toBeNull();
    await m.onModuleDestroy();
  });
});
