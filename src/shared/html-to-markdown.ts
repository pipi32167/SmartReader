/**
 * HTML to Markdown converter
 * Pure functions - depends only on DOM APIs, no browser-specific APIs
 */

const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe',
  'nav', 'header', 'footer', 'aside'
]);

const SKIP_CLASSES = new Set(['sidebar', 'ads', 'advertisement']);
const SKIP_ROLES = new Set(['banner', 'complementary', 'contentinfo']);

function shouldSkipElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;

  for (const cls of SKIP_CLASSES) {
    if (el.classList.contains(cls)) return true;
  }

  const role = el.getAttribute('role');
  if (role && SKIP_ROLES.has(role)) return true;

  if (el.hasAttribute('hidden')) return true;

  const style = el.getAttribute('style') || '';
  if (style.includes('display: none') || style.includes('visibility: hidden')) return true;

  return false;
}

export function htmlToMarkdown(element: Element): string {
  // Process the element directly (no clone) so Shadow DOM is preserved.
  // Unwanted elements are skipped inside convertNode.
  return convertNode(element);
}

export function convertNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node as Element;

  if (shouldSkipElement(el)) {
    return '';
  }

  const tag = el.tagName.toLowerCase();

  // Traverse shadow DOM if present (e.g. Reddit's shreddit-post Web Components)
  const childNodes = el.shadowRoot
    ? Array.from(el.shadowRoot.childNodes)
    : Array.from(el.childNodes);

  const children = childNodes.map(convertNode).join('');
  const elementChildren = childNodes.filter(n => n.nodeType === Node.ELEMENT_NODE) as Element[];

  switch (tag) {
    case 'h1': return '\n# ' + children.trim() + '\n\n';
    case 'h2': return '\n## ' + children.trim() + '\n\n';
    case 'h3': return '\n### ' + children.trim() + '\n\n';
    case 'h4': return '\n#### ' + children.trim() + '\n\n';
    case 'h5': return '\n##### ' + children.trim() + '\n\n';
    case 'h6': return '\n###### ' + children.trim() + '\n\n';
    case 'p': return children.trim() + '\n\n';
    case 'br': return '\n';
    case 'hr': return '\n---\n\n';
    case 'strong':
    case 'b': return '**' + children + '**';
    case 'em':
    case 'i': return '*' + children + '*';
    case 'code': return '`' + children + '`';
    case 'pre': return '\n```\n' + children.trim() + '\n```\n\n';
    case 'a': {
      const href = (el as HTMLAnchorElement).getAttribute('href') || '';
      return '[' + children + '](' + href + ')';
    }
    case 'img': {
      const src = (el as HTMLImageElement).getAttribute('src') || '';
      const alt = (el as HTMLImageElement).getAttribute('alt') || '';
      return '![' + alt + '](' + src + ')';
    }
    case 'audio': {
      const src = (el as HTMLAudioElement).getAttribute('src') || '';
      const sourceSrcs = Array.from(el.querySelectorAll('source'))
        .map(s => s.getAttribute('src') || '')
        .filter(Boolean);
      const allSrcs = src ? [src, ...sourceSrcs] : sourceSrcs;
      if (allSrcs.length === 0) return children;
      return '\n🎵 **Audio**\n' + allSrcs.map(s => '- [' + s + '](' + s + ')').join('\n') + '\n\n';
    }
    case 'video': {
      const src = (el as HTMLVideoElement).getAttribute('src') || '';
      const sourceSrcs = Array.from(el.querySelectorAll('source'))
        .map(s => s.getAttribute('src') || '')
        .filter(Boolean);
      const poster = (el as HTMLVideoElement).getAttribute('poster') || '';
      const allSrcs = src ? [src, ...sourceSrcs] : sourceSrcs;
      if (allSrcs.length === 0) return children;
      let result = '\n🎬 **Video**\n' + allSrcs.map(s => '- [' + s + '](' + s + ')').join('\n') + '\n';
      if (poster) result += '- Poster: [' + poster + '](' + poster + ')\n';
      return result + '\n';
    }
    case 'ul': {
      const items = elementChildren.map(li => '- ' + convertNode(li).trim()).join('\n');
      return '\n' + items + '\n\n';
    }
    case 'ol': {
      const items = elementChildren.map((li, i) => (i + 1) + '. ' + convertNode(li).trim()).join('\n');
      return '\n' + items + '\n\n';
    }
    case 'li': return children;
    case 'blockquote': return '\n> ' + children.trim().replace(/\n/g, '\n> ') + '\n\n';
    case 'table': return '\n' + convertTable(el as HTMLTableElement) + '\n\n';
    case 'div':
    case 'span':
    case 'article':
    case 'main':
    case 'section': return children;
    default: return children;
  }
}

export function convertTable(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  let result = '';
  rows.forEach((row, i) => {
    const cells = Array.from(row.querySelectorAll('td, th'));
    const cellTexts = cells.map(cell => convertNode(cell).trim().replace(/\|/g, '\\|'));
    result += '| ' + cellTexts.join(' | ') + ' |\n';
    if (i === 0) {
      result += '|' + cellTexts.map(() => ' --- ').join('|') + '|\n';
    }
  });
  return result;
}
