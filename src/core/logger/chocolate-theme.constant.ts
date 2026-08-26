/**
 * Chocolate Palette & ANSI Formatting for AppLogger
 * A warm, elegant chocolate-themed terminal styling system.
 */

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Chocolate Palette (256-color & truecolor ANSI)
  darkChocolate: '\x1b[38;5;94m', // #8b4513
  milkChocolate: '\x1b[38;5;130m', // #af5f00
  caramel: '\x1b[38;5;214m', // #ffaf00
  cinnamon: '\x1b[38;5;172m', // #d78700
  mocha: '\x1b[38;5;137m', // #af875f
  vanilla: '\x1b[38;5;229m', // #ffffaf
  warmGray: '\x1b[38;5;244m', // #808080

  // Status Colors
  successMint: '\x1b[38;5;114m', // #87d787
  warnAmber: '\x1b[38;5;215m', // #ffaf5f
  errorCrimson: '\x1b[38;5;196m', // #ff0000
  errorRuby: '\x1b[38;5;160m', // #d70000
  debugCyan: '\x1b[38;5;117m', // #87d7ff
  tracePurple: '\x1b[38;5;141m', // #af87ff

  // Backgrounds
  bgDarkChocolate: '\x1b[48;5;52m',
  bgCaramel: '\x1b[48;5;130m',
  bgCrimson: '\x1b[48;5;124m',
};

export const ChocolateTheme = {
  timestamp: (ts: string) => `${ANSI.warmGray}[${ts}]${ANSI.reset}`,

  badge: (label: string, color: string) =>
    `${ANSI.bold}${color}[${label}]${ANSI.reset}`,

  context: (ctx: string) =>
    `${ANSI.darkChocolate}[${ANSI.caramel}${ctx}${ANSI.darkChocolate}]${ANSI.reset}`,

  requestId: (id: string) => `${ANSI.cinnamon}#${id}${ANSI.reset}`,

  duration: (ms: number) => {
    const color =
      ms > 1000 ? ANSI.errorRuby : ms > 300 ? ANSI.warnAmber : ANSI.successMint;
    return `${color}+${ms}ms${ANSI.reset}`;
  },

  method: (method: string) => {
    switch (method.toUpperCase()) {
      case 'GET':
        return `${ANSI.successMint}${method}${ANSI.reset}`;
      case 'POST':
        return `${ANSI.caramel}${method}${ANSI.reset}`;
      case 'PUT':
      case 'PATCH':
        return `${ANSI.warnAmber}${method}${ANSI.reset}`;
      case 'DELETE':
        return `${ANSI.errorCrimson}${method}${ANSI.reset}`;
      default:
        return `${ANSI.mocha}${method}${ANSI.reset}`;
    }
  },

  status: (code: number) => {
    if (code >= 500) return `${ANSI.errorCrimson}${code}${ANSI.reset}`;
    if (code >= 400) return `${ANSI.warnAmber}${code}${ANSI.reset}`;
    if (code >= 300) return `${ANSI.cinnamon}${code}${ANSI.reset}`;
    if (code >= 200) return `${ANSI.successMint}${code}${ANSI.reset}`;
    return `${ANSI.mocha}${code}${ANSI.reset}`;
  },
};
