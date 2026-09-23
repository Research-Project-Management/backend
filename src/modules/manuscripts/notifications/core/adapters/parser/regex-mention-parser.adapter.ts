import { Injectable } from '@nestjs/common';
import { IMentionParserPort } from '../../ports/mention-parser.port';
import { MentionToken } from '../../domain/value-objects/mention-token.vo';

@Injectable()
export class RegexMentionParserAdapter implements IMentionParserPort {
  // Matches @email (e.g. @user@domain.com) or standard @handle (e.g. @alice)
  // Negative lookbehind ensures the leading @ isn't part of an existing email address
  private readonly mentionRegex = /(?<![a-zA-Z0-9_.+-])@([a-zA-Z0-9_.+-]+(?:@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)?)/g;

  extractMentions(text: string): MentionToken[] {
    if (!text || typeof text !== 'string') {
      return [];
    }

    const tokens: MentionToken[] = [];
    const seenHandles = new Set<string>();

    let match: RegExpExecArray | null;
    this.mentionRegex.lastIndex = 0;

    while ((match = this.mentionRegex.exec(text)) !== null) {
      const rawMatch = match[0]; // e.g. "@alice" or "@bob," or "@someone@email.com"
      let handle = match[1];

      // Clean trailing punctuation commonly attached to end of tags in sentences (.,;:!?)
      handle = handle.replace(/[.,;:!?]+$/, '');

      if (!handle || handle.length < 2) {
        continue;
      }

      const lowerHandle = handle.toLowerCase();
      if (seenHandles.has(lowerHandle)) {
        continue;
      }
      seenHandles.add(lowerHandle);

      const isEmail = handle.includes('@') && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(handle);
      tokens.push(MentionToken.create(rawMatch, handle, match.index, isEmail));
    }

    return tokens;
  }
}
