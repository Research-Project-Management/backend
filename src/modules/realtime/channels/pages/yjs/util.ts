import * as Y from 'yjs';
import { YjsCursorDiffEngine } from './merge';

export function applyTextEditsAndCapture(
  doc: Y.Doc,
  yText: Y.Text,
  currentText: string,
  nextText: string,
  origin: string,
): Uint8Array | null {
  let captured: Uint8Array | null = null;
  const capture = (update: Uint8Array) => {
    captured = captured ? Y.mergeUpdates([captured, update]) : update;
  };
  doc.on('update', capture);
  try {
    YjsCursorDiffEngine.applyEditsToYText(
      doc,
      yText,
      currentText,
      nextText,
      origin,
    );
  } finally {
    doc.off('update', capture);
  }
  return captured;
}
