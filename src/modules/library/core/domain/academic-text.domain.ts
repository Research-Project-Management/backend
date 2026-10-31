import {
  BANNED_STRINGS,
  HTML_ENTITY_CODEPOINTS,
  HTML_ENTITY_REGEX,
  DOUBLE_ENCODED_TAG_REGEX,
  INLINE_FORMAT_TAG_REGEX,
  LATEX_SPECIAL_MACROS,
  LATEX_COMBINING_MAP,
  UNICODE_SUB_MAP,
  UNICODE_SUP_MAP,
  MATH_BLOCK_REGEX,
} from './academic-text.lexicon';

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
  if (code >= 0xd800 && code <= 0xdfff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Decodes named, decimal, and hexadecimal HTML/XML entities into UTF-8 text.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!text.includes('&')) return text;

  return text.replace(
    HTML_ENTITY_REGEX,
    (match: string, named?: string, dec?: string, hex?: string) => {
      if (named) {
        const key: string = Object.prototype.hasOwnProperty.call(
          HTML_ENTITY_CODEPOINTS,
          named,
        )
          ? named
          : named.toLowerCase();
        if (
          !Object.prototype.hasOwnProperty.call(HTML_ENTITY_CODEPOINTS, key)
        ) {
          return match;
        }
        const cp = HTML_ENTITY_CODEPOINTS[key];
        return cp === 0 ? '' : String.fromCodePoint(cp);
      }
      if (dec) {
        return safeFromCodePoint(parseInt(dec, 10));
      }
      if (hex) {
        return safeFromCodePoint(parseInt(hex, 16));
      }
      return match;
    },
  );
}

/**
 * Converts <sub>/<sup> (incl. JATS-prefixed) to Unicode sub/superscripts when
 * every character of the content is mappable; otherwise keeps the raw content
 * (the tag is dropped without inserting spaces, e.g. "CO<sub>2max</sub>" →
 * "CO2max").
 */
export function convertSubSupTagsToUnicode(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!/<(?:jats:|mml:)?su[bp]\b/i.test(text)) return text;
  const mapAll = (content: string, map: Record<string, string>) => {
    const inner = content.trim();
    if (!inner) return content;
    let out = '';
    for (const ch of inner) {
      const mapped = map[ch];
      if (!mapped) return content;
      out += mapped;
    }
    return out;
  };
  return text
    .replace(
      /<(?:jats:|mml:)?sub\b[^>]*>([\s\S]*?)<\/(?:jats:|mml:)?sub>/gi,
      (_, content: string) => mapAll(content, UNICODE_SUB_MAP),
    )
    .replace(
      /<(?:jats:|mml:)?sup\b[^>]*>([\s\S]*?)<\/(?:jats:|mml:)?sup>/gi,
      (_, content: string) => mapAll(content, UNICODE_SUP_MAP),
    );
}

/**
 * Strips XML and HTML tags including JATS XML (<jats:...>), math tags, etc.
 * - Double-encoded tags (&lt;i&gt;) are decoded first so they get stripped.
 * - <sub>/<sup> become Unicode sub/superscripts where fully mappable.
 * - Inline formatting tags (i, b, em, strong, sub, sup, sc, span, ...) are
 *   removed without inserting spaces; block-level tags become a space.
 */
export function stripXmlAndHtmlTags(text: string): string {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  if (out.includes('&')) {
    out = out.replace(DOUBLE_ENCODED_TAG_REGEX, '<$1>');
  }
  out = convertSubSupTagsToUnicode(out);

  const mathPlaceholders: string[] = [];
  if (/[$\\]/.test(out)) {
    out = out.replace(MATH_BLOCK_REGEX, (match) => {
      const idx = mathPlaceholders.length;
      mathPlaceholders.push(match);
      return `@@MATH_TAG_GUARD_${idx}@@`;
    });
  }

  out = out.replace(INLINE_FORMAT_TAG_REGEX, '');
  out = out
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (mathPlaceholders.length > 0) {
    out = out.replace(
      /@@MATH_TAG_GUARD_(\d+)@@/g,
      (m, idxStr: string) => mathPlaceholders[Number(idxStr)] ?? m,
    );
  }
  return out;
}

/**
 * Converts rich academic/Zotero HTML note content into clean Markdown.
 */
export function convertAcademicHtmlToMarkdown(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  if (
    !/<\/?[a-z][\s\S]*>/i.test(raw) &&
    !raw.includes('&') &&
    !raw.includes('\r')
  ) {
    return raw
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  const transformed = raw
    .replace(/\r\n/g, '\n')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(
      /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
      (_, c: string) => `# ${c.trim()}\n\n`,
    )
    .replace(
      /<h2[^>]*>([\s\S]*?)<\/h2>/gi,
      (_, c: string) => `## ${c.trim()}\n\n`,
    )
    .replace(
      /<h3[^>]*>([\s\S]*?)<\/h3>/gi,
      (_, c: string) => `### ${c.trim()}\n\n`,
    )
    .replace(
      /<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi,
      (_, c: string) => `#### ${c.trim()}\n\n`,
    )
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, c: string) => {
      const inner = c
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
        .replace(/<\/?p[^>]*>/gi, '')
        .trim();
      const quoted = inner
        .split(/\r?\n/)
        .map((line) => `> ${line.trim()}`)
        .join('\n');
      return `${quoted}\n\n`;
    })
    .replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner: string) => {
      let itemIndex = 0;
      const items: string[] = [];
      inner.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (__, itemContent: string) => {
          itemIndex += 1;
          items.push(`${itemIndex}. ${itemContent.trim()}`);
          return '';
        },
      );
      return `\n\n${items.join('\n')}\n\n`;
    })
    .replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner: string) => {
      const items: string[] = [];
      inner.replace(
        /<li[^>]*>([\s\S]*?)<\/li>/gi,
        (__, itemContent: string) => {
          items.push(`- ${itemContent.trim()}`);
          return '';
        },
      );
      return `\n\n${items.join('\n')}\n\n`;
    })
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c: string) => `- ${c.trim()}\n`)
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, c: string) => `${c.trim()}\n\n`)
    .replace(/<\/div>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(
      /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
      (_, href: string, label: string) => {
        const cleanHref = href.trim();
        if (/^(https?:\/\/|mailto:)/i.test(cleanHref)) {
          return `[${label}](${cleanHref})`;
        }
        return label;
      },
    )
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s[^<>]*)?\/?>/g, '');

  return decodeHtmlEntities(transformed)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeLatexOutsideMath(segment: string): string {
  let s = segment;
  for (const [pattern, replacement] of LATEX_SPECIAL_MACROS) {
    s = s.replace(pattern, replacement);
  }
  // Symbol accent commands: {\"o}, {\"{o}}, \"o, \"{o}, \'e, \`a, \^o, \~n, \=a, \.z (run twice for stacked Vietnamese diacritics like \~{\^e} -> ễ)
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(
      /\{?\\([uvHckrdb])\{\\?([^\W\d_])\}\}?|\{\\([uvHckrdb])\s+\\?([^\W\d_])\}|\\([uvHckrdb])\s+\\?([^\W\d_])/gu,
      (_, cmd1, ch1, cmd2, ch2, cmd3, ch3) => {
        const cmd = (cmd1 || cmd2 || cmd3) as string;
        const ch = (ch1 || ch2 || ch3) as string;
        const comb = LATEX_COMBINING_MAP[cmd];
        return comb ? (ch + comb).normalize('NFC') : ch;
      },
    );
    s = s.replace(
      /\{?\\(["'`^~=.])\{?\\?([^\W\d_])\}?\}?/gu,
      (_, cmd: string, ch: string) => {
        const comb = LATEX_COMBINING_MAP[cmd];
        return comb ? (ch + comb).normalize('NFC') : ch;
      },
    );
  }
  s = s
    .replace(/\b([Nn]guy)ẽn\b/gu, '$1ễn')
    .replace(/\b([Tt]r)àn\b/gu, '$1ần');
  // Strip LaTeX text-formatting command names before removing braces
  s = s.replace(
    /\\(?:textbf|textit|emph|textsc|textsf|texttt|textrm|text|mathrm|mathbf|mathit|bf|it|rm|sc)\b\s*/g,
    '',
  );
  return s.replace(/[{}]/g, '');
}

/**
 * Strips LaTeX curly braces (e.g. "{Deep Learning}" -> "Deep Learning")
 * and decodes LaTeX diacritic sequences (e.g. "{\"o}" -> "ö", "{\v{s}}" -> "š").
 * Braces inside math segments ($...$, $$...$$, \(...\), \[...\], \begin..\end)
 * are preserved so formulas such as "$\mathcal{O}(n^{2})$" stay intact.
 */
export function stripLatexBraces(text: string): string {
  if (!text || typeof text !== 'string') return '';
  if (!/[{}\\]/.test(text)) return text.trim();
  if (!/[$\\]/.test(text)) return text.replace(/[{}]/g, '').trim();

  let result = '';
  let lastIndex = 0;
  text.replace(MATH_BLOCK_REGEX, (match: string, ...args: unknown[]) => {
    const offset = args[args.length - 2] as number;
    result += decodeLatexOutsideMath(text.slice(lastIndex, offset));
    result += match;
    lastIndex = offset + match.length;
    return match;
  });
  result += decodeLatexOutsideMath(text.slice(lastIndex));
  return result.trim();
}

/**
 * Completely cleans bibliographic text:
 * 1. Strips XML/HTML tags
 * 2. Decodes all HTML entities
 * 3. Strips stray LaTeX braces
 * 4. Collapses multi-line / excessive whitespace into a single space
 */
export function cleanBibliographicText(
  text?: string | null,
): string | undefined {
  if (!text || typeof text !== 'string') return undefined;

  let cleaned = stripXmlAndHtmlTags(text);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned || BANNED_STRINGS.has(cleaned.toLowerCase())) {
    return undefined;
  }

  return cleaned;
}

/**
 * Filters out placeholder strings ('undefined', 'null', 'n/a', 'none', etc.).
 */
export function cleanBannedString(val?: string | null): string | undefined {
  if (val === undefined || val === null) return undefined;
  const str = String(val).trim();
  if (BANNED_STRINGS.has(str.toLowerCase())) {
    return undefined;
  }
  return str;
}

/**
 * Sanitizes and normalizes an author or repository comment (e.g. from arXiv, BibTeX, RIS).
 * Strips XML/HTML tags, decodes HTML entities, strips stray LaTeX braces,
 * collapses redundant whitespace, removes embedded 'Comment:' prefix,
 * and rejects noise, ellipsis, or placeholder strings.
 */
export function cleanCommentText(comment?: string | null): string | undefined {
  if (!comment || typeof comment !== 'string') return undefined;

  let cleaned = stripXmlAndHtmlTags(comment);
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  if (!cleaned) return undefined;

  // Strip leading redundant 'Comment:' if already embedded in text
  cleaned = cleaned.replace(/^comments?:\s*/i, '').trim();

  // Reject if string contains no alphanumeric characters (e.g. "...", "…", "--", "[]")
  if (!/[a-zA-Z0-9\u00C0-\u024F\u1EA0-\u1EF9]/.test(cleaned)) {
    return undefined;
  }

  const lower = cleaned.toLowerCase();
  if (
    BANNED_STRINGS.has(lower) ||
    lower === 'nil' ||
    lower === 'none.' ||
    lower === 'n/a.' ||
    lower === 'etc.' ||
    lower === 'etc' ||
    lower === 'no comment' ||
    lower === 'no comments' ||
    /^(\.{2,}|…|[-_—\s]+|null|undefined|none|n\/?a)$/i.test(cleaned)
  ) {
    return undefined;
  }

  // Reject truncated placeholder comments like "Submitted to ..." or "Accepted for publication in ..."
  if (
    /^(?:submitted to|to appear in|accepted in|accepted to)\s*(?:\.{2,}|…|\s*)$/i.test(
      cleaned,
    )
  ) {
    return undefined;
  }

  return cleaned;
}

export function convertSubscriptsToUnicode(str: string): string {
  return str
    .split('')
    .map((c) => UNICODE_SUB_MAP[c.toLowerCase()] || c)
    .join('');
}

export function convertSuperscriptsToUnicode(str: string): string {
  return str
    .split('')
    .map((c) => UNICODE_SUP_MAP[c.toLowerCase()] || c)
    .join('');
}

/**
 * Sanitizes and normalizes an academic paper abstract.
 * 0. Protects mathematical formulas ($...$, $$...$$, \(...\), \[...\], \begin{...}...\end{...}) and pre-extracts JATS <tex-math>.
 * 1. Pre-processes JATS XML (<jats:...>), PubMed (<AbstractText>), and HTML tags before stripping.
 * 2. Converts chemical and numerical <sub>/<sup> to native Unicode (H₂O, 10⁻⁵).
 * 3. Normalizes structured section titles into formatted Markdown bold headings (**Background:**).
 * 4. Decodes HTML entities and strips remaining XML/HTML tags and non-math formatting braces.
 * 5. Strips leading "Abstract", "ABSTRACT", "Summary", "Graphical Abstract" prefixes.
 * 6. Removes repeated year extraction artifacts (e.g. "(2012)(2013)(2014)(2015)(2016)(2017).").
 * 7. Removes trailing author contribution, publisher copyright banners (Elsevier, Springer, Wiley, MDPI, IEEE, ACM), and index terms noise.
 * 8. Unwraps single hard line-breaks within paragraphs while preserving double-newline paragraph separation.
 * 9. Restores preserved mathematical formulas completely intact.
 */
export function cleanAbstractText(text?: string | null): string | undefined {
  if (!text || typeof text !== 'string') return undefined;

  let cleaned = text;

  // 0a. Pre-extract JATS XML tex-math tags into standard LaTeX math before masking
  cleaned = cleaned.replace(
    /<(?:jats:)?disp-formula[^>]*>[\s\S]*?<(?:jats:)?tex-math[^>]*>([\s\S]*?)<\/(?:jats:)?tex-math>[\s\S]*?<\/(?:jats:)?disp-formula>/gi,
    (_, math: string) => {
      const trimmed = math
        .trim()
        .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
        .trim();
      const content = trimmed.replace(/^\$\$?([\s\S]*?)\$\$?$/, '$1').trim();
      return `\n\n$$${content}$$\n\n`;
    },
  );
  cleaned = cleaned.replace(
    /<(?:jats:)?(?:inline-formula[^>]*>[\s\S]*?)?<(?:jats:)?tex-math[^>]*>([\s\S]*?)<\/(?:jats:)?tex-math>(?:[\s\S]*?<\/(?:jats:)?inline-formula>)?/gi,
    (_, math: string) => {
      const trimmed = math
        .trim()
        .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
        .trim();
      const content = trimmed.replace(/^\$([\s\S]*?)\$$/, '$1').trim();
      return `$${content}$`;
    },
  );

  // 0b. Protect mathematical formulas from accidental tag-stripping or LaTeX brace removal
  const mathPlaceholders: string[] = [];
  cleaned = cleaned.replace(MATH_BLOCK_REGEX, (match) => {
    const placeholder = `@@MATH_BLOCK_${mathPlaceholders.length}@@`;
    mathPlaceholders.push(match);
    return placeholder;
  });

  // 1. Fix hyphenated words broken across line wraps before tag/whitespace stripping
  cleaned = cleaned.replace(
    /([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g,
    '$1$2',
  );

  // 2. Structured JATS / PubMed / HTML Pre-Processing
  // Convert <sub> and <sup> tags to scientific Unicode characters before stripping
  cleaned = convertSubSupTagsToUnicode(cleaned);

  // Remove generic abstract headings inside JATS/HTML tags
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>\s*(?:Abstract|Summary|Résumé|Overview)\s*<\/(?:jats:)?title>/gi,
    '',
  );
  // Convert structured section titles into formatted plain-text headings (e.g. "**Background:** ", "**Methods:** ")
  cleaned = cleaned.replace(
    /<(?:jats:)?title[^>]*>([\s\S]*?)<\/(?:jats:)?title>/gi,
    (_, title: string) => {
      const cleanTitle = title.trim().replace(/[:.\s]+$/, '');
      return cleanTitle ? `\n\n**${cleanTitle}:** ` : '';
    },
  );
  // PubMed structured abstract tags: <AbstractText Label="BACKGROUND">...</AbstractText>
  cleaned = cleaned.replace(
    /<AbstractText\s+[^>]*Label=["']\s*([^"']+?)\s*["'][^>]*>([\s\S]*?)<\/AbstractText>/gi,
    (_, label: string, content: string) =>
      `\n\n**${label.trim()}:** ${content.trim()}`,
  );
  // Unlabeled AbstractText tags become paragraph breaks
  cleaned = cleaned.replace(
    /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi,
    '\n\n$1',
  );
  // Convert paragraph break tags to newlines
  cleaned = cleaned.replace(/<\/(?:jats:)?p>/gi, '\n\n');
  cleaned = cleaned.replace(/<(?:jats:)?p[^>]*>/gi, '');
  cleaned = cleaned.replace(/<br\s*\/?>/gi, '\n');
  cleaned = cleaned.replace(/<\/(?:jats:)?sec>/gi, '\n\n');

  // Strip remaining XML/HTML tags without flattening paragraph newlines
  // (inline formatting tags are dropped without inserting whitespace)
  cleaned = cleaned.replace(INLINE_FORMAT_TAG_REGEX, '');
  cleaned = cleaned
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s[^<>]*)?\/?>/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = stripLatexBraces(cleaned);

  // 2. Remove leading "Abstract" or "ABSTRACT" headings and prefixes
  cleaned = cleaned.replace(
    /^(?:abstract|summary|résumé|synopsis|overview)\b\s*(?:[:.—\-–\u2014\u2013]\s*|\s+(?=[A-Z]))/i,
    '',
  );
  cleaned = cleaned.replace(
    /^(?:graphical\s+abstract|highlights?)\b\s*(?:[:.—\-–\u2014\u2013]\s*|\r?\n+)/i,
    '',
  );
  cleaned = cleaned.replace(
    /^(?:abstract|summary|résumé|synopsis|overview)\s*\r?\n+/i,
    '',
  );

  // 3. Remove repeated parenthesized / bracketed year-chain extraction artifacts
  cleaned = cleaned.replace(/(?:\((?:19|20)\d{2}\)\s*){2,}(\.)?/g, (_, dot) =>
    dot ? '.' : '',
  );
  cleaned = cleaned.replace(/(?:\[(?:19|20)\d{2}\]\s*){2,}(\.)?/g, (_, dot) =>
    dot ? '.' : '',
  );
  cleaned = cleaned.replace(
    /\((?:(?:19|20)\d{2}[,\s;]*){3,}\)(\.)?/g,
    (_, dot) => (dot ? '.' : ''),
  );

  // 4. Remove trailing author contribution / footnote / correspondence noise
  cleaned = cleaned.replace(
    /(?:(?:\n\s*|\.\s+)[*†‡§\d]*\s*(?:Equal contribution|Corresponding author|Correspondence to|Author ordering|Listing order|These authors contributed equally|Work performed while|Supported in part by|This work was supported by|Electronic address\s*:|E-?mail\s*:)[\s\S]*$)/i,
    '.',
  );

  // 5. Remove trailing publication metadata, index terms, PACS numbers, keywords
  cleaned = cleaned.replace(
    /(?:\n\s*|\.\s+)(?:ACM Reference [Ff]ormat|Index Terms|Keywords|Key\s*words|Additional Key Words and Phrases|PACS numbers?|Subject classification|MSC classes?)\s*[:—\-–]\s*[\s\S]*$/i,
    '',
  );

  // 6. Remove publisher copyright notices and banners
  const COPYRIGHT_PATTERNS = [
    // Elsevier / Academic Press
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*(?:Elsevier|Academic Press)|Published by Elsevier|All rights reserved\b)[\s\S]*$/i,
    // Springer Nature / BioMed Central
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:The Author\(s\)|(?:19|20)\d{2}\s*(?:Springer|Nature|BioMed Central)))[\s\S]*$/i,
    // Wiley
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*John Wiley & Sons|Copyright\s*(?:\(c\)|©)\s*(?:19|20)\d{2}\s*Wiley)[\s\S]*$/i,
    // MDPI
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*by the authors?\. Licensee MDPI[\s\S]*$)/i,
    // Oxford / Cambridge / Taylor & Francis
    /(?:(?:Copyright\s*)?(?:\(c\)|©)\s*(?:19|20)\d{2}\s*(?:Oxford University Press|Cambridge University Press|Informa UK|Taylor & Francis))[\s\S]*$/i,
    // Creative Commons licenses
    /(?:This article is distributed under the terms of the Creative Commons|Licensed under a Creative Commons)[\s\S]*$/i,
    // IEEE / ACM / explicit copyright statements (requires ©/(c), "by", "all rights reserved", or publisher name so prose like "Copyright 1998" is preserved)
    /(?:Copyright\s*(?:\(c\)|©)\s*(?:19|20)\d{2}|Copyright\s+(?:19|20)\d{2}\s+(?:by\b|IEEE\b|ACM\b|Elsevier\b|Springer\b|Wiley\b|Oxford\b|Cambridge\b|Taylor\b|Informa\b|The\s+Authors?\b|All\s+rights\s+reserved\b)|©\s*(?:19|20)\d{2}\s*(?:IEEE|ACM|by\b))[\s\S]*$/i,
    /\b\d{4}-\d{3}[\dX]\s*(?:\(c\)|©)?\s*\d{4}\s*IEEE[\s\S]*$/i,
  ];

  for (const pattern of COPYRIGHT_PATTERNS) {
    const dotRegex = new RegExp(`\\.\\s*${pattern.source}`, pattern.flags);
    cleaned = cleaned.replace(dotRegex, '.');
    const wsRegex = new RegExp(
      `(?:\\n\\s*|\\s+)${pattern.source}`,
      pattern.flags,
    );
    cleaned = cleaned.replace(wsRegex, '');
  }

  // 7. Normalize paragraphs & unwrap hard line-breaks within each paragraph
  const rawParagraphs = cleaned.split(/\r?\n\s*\r?\n/);
  const normalizedParagraphs = rawParagraphs
    .map((paragraph) => {
      // Fix hyphenation across breaks (e.g., "stochas- tic" -> "stochastic")
      let p = paragraph.replace(
        /([a-zA-Z]{2,})-\s*\r?\n\s*([a-zA-Z]{2,})/g,
        '$1$2',
      );
      // Collapse single newlines into a single space
      p = p.replace(/\r?\n/g, ' ');
      // Collapse multiple whitespace
      p = p.replace(/\s+/g, ' ').trim();
      // Clean spacing before punctuation: "word ." -> "word."
      p = p.replace(/\s+([.,;:!?%)\]}’'”])/g, '$1');
      // Clean spacing after opening punctuation: "( word" -> "(word"
      p = p.replace(/([([{‘'“])\s+/g, '$1');
      // Clean duplicate periods (excluding ellipsis)
      p = p.replace(/\.\s*\.(?!\.)/g, '.');
      return p;
    })
    .filter((p) => p.length > 0);

  cleaned = normalizedParagraphs.join('\n\n').trim();

  // 8. Restore preserved mathematical formulas completely intact
  if (mathPlaceholders.length > 0) {
    cleaned = cleaned.replace(
      /@@MATH_BLOCK_(\d+)@@/g,
      (match: string, index: string) => {
        const idx = parseInt(index, 10);
        return mathPlaceholders[idx] !== undefined
          ? mathPlaceholders[idx]
          : match;
      },
    );
  }

  if (
    !cleaned ||
    cleaned.length < 15 ||
    BANNED_STRINGS.has(cleaned.toLowerCase())
  ) {
    return undefined;
  }

  return cleaned;
}

export function extractYearFromDate(
  dateStr?: string | null,
): number | undefined {
  if (!dateStr || typeof dateStr !== 'string') return undefined;
  const match = dateStr.match(/\b(1\d{3}|20\d{2})\b/);
  return match ? parseInt(match[1], 10) : undefined;
}

/**
 * Normalizes a page range:
 * - "--", en dash, em dash, minus and other dash variants → "-"
 * - Expands Medline-style abbreviated ranges ("857-63" → "857-863")
 *   only when the abbreviated end would otherwise be smaller than the start.
 */
export function normalizePageRange(pages?: string | null): string | undefined {
  if (!pages || typeof pages !== 'string') return undefined;
  let cleaned = pages
    .trim()
    .replace(/\s*(?:--+|[\u2010-\u2015\u2212])\s*/g, '-')
    .replace(/\s*-\s*/g, '-');
  cleaned = cleaned.replace(
    /\b(\d+)-(\d+)\b/g,
    (m, start: string, end: string) => {
      if (end.length >= start.length) return m;
      const expanded = start.slice(0, start.length - end.length) + end;
      return parseInt(expanded, 10) > parseInt(start, 10)
        ? `${start}-${expanded}`
        : m;
    },
  );
  return cleaned || undefined;
}
