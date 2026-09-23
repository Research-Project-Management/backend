export type CompilerType = 'pdflatex' | 'latex' | 'xelatex' | 'lualatex';

export class CompilerTypeVo {
  private static readonly VALID_COMPILERS = new Set<string>([
    'pdflatex',
    'latex',
    'xelatex',
    'lualatex',
  ]);

  static isValid(compiler: string): compiler is CompilerType {
    return this.VALID_COMPILERS.has(compiler.toLowerCase());
  }

  static fromString(compiler?: string): CompilerType {
    if (!compiler) return 'pdflatex';
    const clean = compiler.toLowerCase().trim();
    if (this.isValid(clean)) {
      return clean;
    }
    return 'pdflatex';
  }
}
