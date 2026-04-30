// Content Script - Runs in the context of web pages
import { htmlToMarkdown } from '../shared/html-to-markdown';
import { Readability } from '@mozilla/readability';

function extractMainContent(): string {
  // 1. Try Mozilla Readability (Firefox Reader View algorithm)
  let readabilityMd = '';
  try {
    const reader = new Readability(document.cloneNode(true) as Document);
    const article = reader.parse();
    if (article && article.content) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(article.content, 'text/html');
      const md = htmlToMarkdown(doc.body);
      if (md.trim().length >= 300) {
        readabilityMd = md;
      }
    }
  } catch {
    // Readability failed, continue
  }

  // 2. Try semantic container selectors
  let selectorMd = '';
  const selectors = ['#Main', 'article', 'main', '[role="main"]', '.content', '.post', '.article', 'shreddit-post'];
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) {
      const md = htmlToMarkdown(element);
      if (md.trim().length >= 300) {
        selectorMd = md;
        break;
      }
    }
  }

  // 3. Choose the better result:
  //    - If selector output is significantly longer (>1.5x), the page likely has
  //      a comment/forum section that Readability stripped. Prefer selector.
  //    - Otherwise prefer Readability for clean article extraction.
  if (readabilityMd && selectorMd) {
    if (selectorMd.length > readabilityMd.length * 1.5) {
      return selectorMd;
    }
    return readabilityMd;
  }
  if (readabilityMd) return readabilityMd;
  if (selectorMd) return selectorMd;

  // 4. Fallback: body minus junk
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style, nav, header, footer, aside, iframe, svg').forEach(e => e.remove());
  const md = htmlToMarkdown(clone);
  if (md.trim().length >= 300) {
    return md;
  }

  // 5. Last resort: plain text extraction (handles Shadow DOM sites like Reddit)
  return document.body.innerText;
}

/**
 * Scan for media URLs in data attributes, tooltip elements, and aria-describedby targets.
 */
function scanForMediaUrls(urls: Set<string>): void {
  // 1. data-* attributes
  document.querySelectorAll('*').forEach(el => {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && /^https?:\/\/.+\.(mp3|mp4|wav|ogg|webm|m3u8)/i.test(attr.value)) {
        urls.add(attr.value);
      }
    }
  });

  // 2. aria-describedby targets
  document.querySelectorAll('[aria-describedby]').forEach(el => {
    const tooltipId = el.getAttribute('aria-describedby');
    if (tooltipId) {
      const tooltipEl = document.getElementById(tooltipId);
      if (tooltipEl) {
        const text = tooltipEl.textContent || '';
        const matches = text.match(/https?:\/\/[^\s]+\.(mp3|mp4|wav|ogg|webm|m3u8)/gi);
        if (matches) matches.forEach(u => urls.add(u));
      }
    }
  });

  // 3. Common tooltip portal containers
  const tooltipSelectors = [
    '.ant-tooltip-inner',
    '[class*="tooltip"]',
    '[class*="Tooltip"]',
    '[role="tooltip"]',
  ];
  tooltipSelectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      const text = el.textContent || '';
      const matches = text.match(/https?:\/\/[^\s]+\.(mp3|mp4|wav|ogg|webm|m3u8)/gi);
      if (matches) matches.forEach(u => urls.add(u));
    });
  });
}

/**
 * Extract media URLs, including triggering hover events to force
 * lazy-rendered tooltips (e.g. Ant Design) into the DOM.
 */
async function extractMediaUrls(): Promise<string[]> {
  const urls = new Set<string>();

  // Static scan first
  scanForMediaUrls(urls);

  // If we found very few, try triggering tooltips by hovering
  if (urls.size < 3) {
    // Find likely tooltip trigger elements (buttons, cells with aria-describedby, etc.)
    const triggers = document.querySelectorAll(
      'button, [aria-describedby], td, [title]'
    );
    const triggerArray = Array.from(triggers).slice(0, 30);

    // Trigger mouseenter on each
    for (const el of triggerArray) {
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
      // Small stagger to avoid overwhelming React re-render queue
      await new Promise(r => setTimeout(r, 30));
    }

    // Give React/Ant Design time to render all portals
    await new Promise(r => setTimeout(r, 300));

    // Scan again with tooltips now in DOM
    scanForMediaUrls(urls);

    // Clean up: trigger mouseleave to hide tooltips
    for (const el of triggerArray) {
      el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, cancelable: true }));
    }
  }

  return Array.from(urls);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_PAGE_CONTENT': {
          const markdown = extractMainContent();
          const mediaUrls = await extractMediaUrls();
          const selection = window.getSelection()?.toString() || '';

          // Append discovered media URLs to markdown
          let finalMarkdown = markdown;
          if (mediaUrls.length > 0) {
            finalMarkdown += '\n\n---\n\n**发现的多媒体链接：**\n';
            mediaUrls.forEach(u => {
              finalMarkdown += '- [' + u + '](' + u + ')\n';
            });
          }

          sendResponse({
            success: true,
            data: {
              title: document.title,
              url: location.href,
              html: finalMarkdown,
              text: selection
            }
          });
          break;
        }

        case 'GET_SELECTION': {
          const selection = window.getSelection()?.toString() || '';
          sendResponse({
            success: true,
            data: {
              title: document.title,
              url: location.href,
              text: selection
            }
          });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error: any) {
      console.error('[Content Script] Error:', error);
      sendResponse({ success: false, error: error.message || 'Unknown error' });
    }
  })();
  return true; // Keep channel open for async
});

console.log('[SmartReader] Content script loaded');
