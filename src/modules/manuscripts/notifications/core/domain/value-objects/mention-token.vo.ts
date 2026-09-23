export class MentionToken {
  readonly raw: string;
  readonly handle: string;
  readonly index: number;
  readonly isEmail: boolean;

  constructor(raw: string, handle: string, index: number, isEmail: boolean = false) {
    this.raw = raw;
    this.handle = handle;
    this.index = index;
    this.isEmail = isEmail;
  }

  static create(raw: string, handle: string, index: number, isEmail: boolean = false): MentionToken {
    return new MentionToken(raw, handle, index, isEmail);
  }
}
