const GENERIC_GREETING_REGEX =
  /^(xin chào|chào bạn|chào|hello|hi|hey|alo|good morning|good afternoon|good evening|tóm tắt tôi file này|tóm tắt file này|tóm tắt paper này)[!.,? ]*$/i;

export function sanitizeChatTitle(rawTitle?: string | null): string {
  if (!rawTitle) return 'New Chat';
  const sanitized = rawTitle
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  return sanitized.length > 0 ? sanitized.slice(0, 100) : 'New Chat';
}

export function deriveInitialChatTitle(
  content: string,
  documentIds?: string[],
): string {
  const trimmed = (content || '').trim();
  if (!trimmed || GENERIC_GREETING_REGEX.test(trimmed.toLowerCase())) {
    if (documentIds && documentIds.length > 0) {
      return 'Tài liệu đính kèm';
    }
    return 'New Chat';
  }
  return sanitizeChatTitle(trimmed);
}

export function isGenericChatTitle(title?: string | null): boolean {
  const trimmed = (title || '').trim();
  if (!trimmed) return true;
  if (trimmed === 'New Chat' || trimmed === 'Tài liệu đính kèm') {
    return true;
  }
  return GENERIC_GREETING_REGEX.test(trimmed);
}

export function cleanGeneratedTitle(raw: string): string | null {
  const stripped = raw
    .replace(/^["'`“”«»]+|["'`“”«»]+$/g, '')
    .replace(/[.!?:;]+$/, '')
    .replace(/^[#*\-•\s]+/, '')
    .replace(/[*_~`]/g, '')
    .trim();
  if (
    stripped.length > 0 &&
    stripped.length <= 60 &&
    !stripped.toLowerCase().includes('offline') &&
    !stripped.toLowerCase().includes('flux-ai')
  ) {
    return stripped;
  }
  return null;
}

export function extractHeuristicTitle(
  userText: string,
  assistantText: string,
): string {
  const cleanUser = (userText || '')
    .replace(
      /^(xin chào|chào bạn|chào|hello|hi|hey|alo|cho tôi hỏi|hãy cho tôi biết|hãy|bạn có thể)\s+/i,
      '',
    )
    .trim();

  if (cleanUser.length >= 5) {
    return sanitizeChatTitle(cleanUser).slice(0, 50);
  }

  if (assistantText && assistantText.length > 10) {
    const firstLine = assistantText
      .split('\n')[0]
      .replace(/^[#*\-•\s]+/, '')
      .trim();
    if (firstLine.length >= 5) {
      return sanitizeChatTitle(firstLine).slice(0, 50);
    }
  }

  return 'Cuộc trò chuyện mới';
}
