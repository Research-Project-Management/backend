import { MentionToken } from '../domain/value-objects/mention-token.vo';

export interface IMentionParserPort {
  extractMentions(text: string): MentionToken[];
}

export const MENTION_PARSER_PORT = Symbol('IMentionParserPort');
