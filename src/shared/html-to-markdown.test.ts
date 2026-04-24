import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { htmlToMarkdown, convertNode } from './html-to-markdown';

// Create a fresh DOM for each test
function createDOM(html: string) {
  const dom = new JSDOM(html);
  return dom.window.document;
}

describe('htmlToMarkdown', () => {
  it('converts headings', () => {
    const doc = createDOM('<h1>Title</h1><h2>Subtitle</h2>');
    const el = doc.body;
    const md = htmlToMarkdown(el);
    expect(md).toContain('# Title');
    expect(md).toContain('## Subtitle');
  });

  it('converts paragraphs and links', () => {
    const doc = createDOM('<p>Hello <a href="https://example.com">world</a></p>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('Hello [world](https://example.com)');
  });

  it('converts images', () => {
    const doc = createDOM('<img src="https://example.com/img.png" alt="desc">');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('![desc](https://example.com/img.png)');
  });

  it('converts audio elements with src', () => {
    const doc = createDOM('<audio src="https://example.com/audio.mp3"></audio>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('🎵 **Audio**');
    expect(md).toContain('- [https://example.com/audio.mp3](https://example.com/audio.mp3)');
  });

  it('converts audio elements with source children', () => {
    const doc = createDOM('<audio><source src="https://example.com/audio.mp3" type="audio/mpeg"></audio>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('🎵 **Audio**');
    expect(md).toContain('- [https://example.com/audio.mp3](https://example.com/audio.mp3)');
  });

  it('converts video elements with src and poster', () => {
    const doc = createDOM('<video src="https://example.com/video.mp4" poster="https://example.com/poster.jpg"></video>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('🎬 **Video**');
    expect(md).toContain('- [https://example.com/video.mp4](https://example.com/video.mp4)');
    expect(md).toContain('- Poster: [https://example.com/poster.jpg](https://example.com/poster.jpg)');
  });

  it('converts unordered lists', () => {
    const doc = createDOM('<ul><li>First</li><li>Second</li></ul>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('- First');
    expect(md).toContain('- Second');
  });

  it('converts ordered lists', () => {
    const doc = createDOM('<ol><li>First</li><li>Second</li></ol>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('1. First');
    expect(md).toContain('2. Second');
  });

  it('converts blockquotes', () => {
    const doc = createDOM('<blockquote>Quote text</blockquote>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('> Quote text');
  });

  it('converts code and pre blocks', () => {
    const doc = createDOM('<code>inline</code><pre>block</pre>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('`inline`');
    expect(md).toContain('```');
    expect(md).toContain('block');
  });

  it('removes script and style elements', () => {
    const doc = createDOM('<p>Text</p><script>alert("x")</script><style>body{}</style>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('Text');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('body{}');
  });

  it('removes hidden elements', () => {
    const doc = createDOM('<p>Visible</p><p hidden>Hidden</p>');
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('Visible');
    expect(md).not.toContain('Hidden');
  });

  it('converts content inside Shadow DOM', () => {
    const doc = createDOM('<div id="host"></div>');
    const host = doc.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Shadow paragraph</p><h2>Shadow heading</h2>';
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('Shadow paragraph');
    expect(md).toContain('## Shadow heading');
  });

  it('converts nested Shadow DOM elements', () => {
    const doc = createDOM('<div id="outer"></div>');
    const outer = doc.getElementById('outer')!;
    const outerShadow = outer.attachShadow({ mode: 'open' });
    outerShadow.innerHTML = '<div id="inner"></div>';
    const inner = outerShadow.getElementById('inner')!;
    const innerShadow = inner.attachShadow({ mode: 'open' });
    innerShadow.innerHTML = '<p>Deep nested content</p>';
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('Deep nested content');
  });
});

describe('table conversion', () => {
  it('converts a simple table', () => {
    const doc = createDOM(`
      <table>
        <tr><th>Name</th><th>Age</th></tr>
        <tr><td>Alice</td><td>30</td></tr>
        <tr><td>Bob</td><td>25</td></tr>
      </table>
    `);
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('| Name | Age |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Alice | 30 |');
    expect(md).toContain('| Bob | 25 |');
  });

  it('escapes pipes in cell content', () => {
    const doc = createDOM(`
      <table>
        <tr><th>A | B</th></tr>
        <tr><td>C | D</td></tr>
      </table>
    `);
    const md = htmlToMarkdown(doc.body);
    expect(md).toContain('| A \\| B |');
    expect(md).toContain('| C \\| D |');
  });

  it('converts complex Ant Design table with nested content', () => {
    const html = `<table style="width: 1500px;">
      <thead>
        <tr>
          <th>音视频信息</th>
          <th style="text-align: center;">播放</th>
          <th style="text-align: center;">标签</th>
          <th style="text-align: center;">创建人</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div style="display: flex; gap: 12px;">
              <div><img src="https://echo101-oss.wemore.com/listen/cover.jpg" alt="封面" style="width: 60px;"></div>
              <div>
                <div style="font-weight: 600;">Gusto Moments Episode 43</div>
                <div>Common Chinese internet words and how to use them in English.</div>
                <div>时长: 00:01:13</div>
              </div>
            </div>
          </td>
          <td style="text-align: center;">
            <button type="button"><span>play-circle</span></button>
          </td>
          <td style="text-align: center;">
            <span>B1</span><span>talks</span><span>culture</span>
          </td>
          <td style="text-align: center;">Kris</td>
        </tr>
        <tr>
          <td>
            <div style="display: flex; gap: 12px;">
              <div><img src="https://echo101-oss.wemore.com/listen/cover2.jpg" alt="封面" style="width: 60px;"></div>
              <div>
                <div style="font-weight: 600;">Gusto Moments Episode 42</div>
                <div>Rat race. Pointless competition.</div>
                <div>时长: 00:00:50</div>
              </div>
            </div>
          </td>
          <td style="text-align: center;">
            <button type="button"><span>play-circle</span></button>
          </td>
          <td style="text-align: center;">
            <span>B1</span><span>talks</span><span>culture</span>
          </td>
          <td style="text-align: center;">Kris</td>
        </tr>
      </tbody>
    </table>`;

    const doc = createDOM(html);
    const md = htmlToMarkdown(doc.body);

    // Should have table structure
    expect(md).toContain('| 音视频信息 | 播放 | 标签 | 创建人 |');
    expect(md).toContain('| --- | --- | --- | --- |');

    // Should include image markdown from table cells
    expect(md).toContain('![封面](https://echo101-oss.wemore.com/listen/cover.jpg)');
    expect(md).toContain('![封面](https://echo101-oss.wemore.com/listen/cover2.jpg)');

    // Should include episode titles
    expect(md).toContain('Gusto Moments Episode 43');
    expect(md).toContain('Gusto Moments Episode 42');

    // Should include duration info
    expect(md).toContain('时长: 00:01:13');
    expect(md).toContain('时长: 00:00:50');

    // Should include creator names
    expect(md).toContain('Kris');

    // Should include tag text (buttons/spans become text)
    expect(md).toContain('play-circle');
    expect(md).toContain('B1');
    expect(md).toContain('talks');
    expect(md).toContain('culture');
  });
});
