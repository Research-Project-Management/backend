export interface SnapshotTemplateParams {
  canonicalUrl: string;
  capturedAtIso: string;
  formattedDate: string;
  title: string;
  byline?: string;
  siteName: string;
  sanitizedBody: string;
}

export function escapeSnapshotHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function buildStandaloneSnapshotHtml(
  params: SnapshotTemplateParams,
): string {
  const {
    canonicalUrl,
    capturedAtIso,
    formattedDate,
    title,
    byline,
    siteName,
    sanitizedBody,
  } = params;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Flux Research Platform - Web Snapshot">
  <meta name="source-url" content="${escapeSnapshotHtml(canonicalUrl)}">
  <meta name="captured-at" content="${capturedAtIso}">
  <title>${escapeSnapshotHtml(title)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #18181b;
      --muted: #71717a;
      --border: #e4e4e7;
      --card: #fafafa;
      --accent: #2563eb;
      --code-bg: #f4f4f5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #09090b;
        --text: #f4f4f5;
        --muted: #a1a1aa;
        --border: #27272a;
        --card: #18181b;
        --accent: #3b82f6;
        --code-bg: #27272a;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1.25rem;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist Sans", sans-serif;
      line-height: 1.65;
      font-size: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .flux-container {
      max-width: 780px;
      margin: 0 auto;
    }
    .flux-badge-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background-color: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 2rem;
    }
    .flux-badge-tag {
      background-color: var(--accent);
      color: #ffffff;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
    }
    .flux-badge-source {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 200px;
    }
    .flux-badge-source a {
      color: var(--accent);
      text-decoration: none;
    }
    .flux-badge-source a:hover {
      text-decoration: underline;
    }
    .flux-badge-time {
      color: var(--muted);
      font-size: 11px;
    }
    h1.flux-title {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.25;
      margin-top: 0;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    .flux-byline {
      color: var(--muted);
      font-size: 14px;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    article img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 1.5rem 0;
    }
    article pre {
      background-color: var(--code-bg);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, "Geist Mono", monospace;
      font-size: 13px;
      border: 1px solid var(--border);
    }
    article code {
      background-color: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: ui-monospace, SFMono-Regular, "Geist Mono", monospace;
    }
    article blockquote {
      margin: 1.5rem 0;
      padding-left: 1rem;
      border-left: 3px solid var(--accent);
      color: var(--muted);
      font-style: italic;
    }
    article table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      font-size: 14px;
    }
    article th, article td {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      text-align: left;
    }
    article th {
      background-color: var(--card);
      font-weight: 600;
    }
    footer.flux-footer {
      margin-top: 4rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="flux-container">
    <div class="flux-badge-bar">
      <span class="flux-badge-tag">Offline Web Snapshot</span>
      <span class="flux-badge-source">
        Source: <a href="${escapeSnapshotHtml(canonicalUrl)}" target="_blank" rel="noopener noreferrer">${escapeSnapshotHtml(canonicalUrl)}</a>
      </span>
      <span class="flux-badge-time">Captured: ${formattedDate}</span>
    </div>

    <h1 class="flux-title">${escapeSnapshotHtml(title)}</h1>
    ${byline ? `<div class="flux-byline">By ${escapeSnapshotHtml(byline)} • ${escapeSnapshotHtml(siteName)}</div>` : `<div class="flux-byline">${escapeSnapshotHtml(siteName)}</div>`}

    <article>
      ${sanitizedBody}
    </article>

    <footer class="flux-footer">
      Archived by Flux Research Platform • Permanent snapshot preserved on ${formattedDate}.
    </footer>
  </div>
</body>
</html>`;
}
