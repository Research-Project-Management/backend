import * as path from 'node:path';

interface AiKnowledgeEnablementConfig {
  enabled?: string;
  url?: string;
  nodeEnv?: string;
}

const INGESTIBLE_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'application/x-markdown',
]);

const INGESTIBLE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  '.txt',
]);

export function isIngestibleDocument(
  filename?: string | null,
  mimeType?: string | null,
): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  return INGESTIBLE_MIME_TYPES.has(mime) || INGESTIBLE_EXTENSIONS.has(ext);
}

export function isAiKnowledgeEnabled(
  config: AiKnowledgeEnablementConfig,
): boolean {
  if (config.enabled === 'true') return true;
  if (config.enabled === 'false') return false;
  if (config.url && config.url.trim().length > 0) return true;
  return config.nodeEnv === 'test';
}
