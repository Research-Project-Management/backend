/**
 * spelling/core/domain/value-objects/dictionary-scope.vo.ts
 * Value Object defining the scope of custom dictionary words.
 */

export type DictionaryScope = 'PROJECT' | 'USER';

export class DictionaryScopeVo {
  public readonly value: DictionaryScope;

  private constructor(value: DictionaryScope) {
    this.value = value;
  }

  public static project(): DictionaryScopeVo {
    return new DictionaryScopeVo('PROJECT');
  }

  public static user(): DictionaryScopeVo {
    return new DictionaryScopeVo('USER');
  }

  public static fromString(raw: string): DictionaryScopeVo {
    const upper = raw.trim().toUpperCase();
    if (upper === 'PROJECT' || upper === 'USER') {
      return new DictionaryScopeVo(upper as DictionaryScope);
    }
    return DictionaryScopeVo.project();
  }

  public isProject(): boolean {
    return this.value === 'PROJECT';
  }

  public isUser(): boolean {
    return this.value === 'USER';
  }

  public toString(): string {
    return this.value;
  }
}
