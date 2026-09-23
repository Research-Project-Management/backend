export type TemplateCategoryString =
  | 'journal'
  | 'conference'
  | 'thesis'
  | 'cv'
  | 'presentation'
  | 'report'
  | 'other';

export class TemplateCategoryVo {
  private static readonly VALID_CATEGORIES = new Set<string>([
    'journal',
    'conference',
    'thesis',
    'cv',
    'presentation',
    'report',
    'other',
  ]);

  static isValid(category: string): category is TemplateCategoryString {
    return this.VALID_CATEGORIES.has(category.toLowerCase());
  }

  static fromString(category?: string): TemplateCategoryString {
    if (!category) return 'other';
    const clean = category.toLowerCase().trim();
    if (this.isValid(clean)) {
      return clean;
    }
    return 'other';
  }
}
