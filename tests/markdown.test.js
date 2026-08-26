import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';

describe('Markdown Renderer - Seam 4', () => {
  it('renders headers, bold, and list items to HTML', () => {
    const md = `## 🎯 核心研报摘要\n- **一句话结论**：这个产品很强\n> 这是一个引用说明`;
    const html = renderMarkdown(md);

    assert.ok(html.includes('<h2>🎯 核心研报摘要</h2>'));
    assert.ok(html.includes('<strong>一句话结论</strong>'));
    assert.ok(html.includes('<li>'));
    assert.ok(html.includes('<blockquote>这是一个引用说明</blockquote>'));
  });

  it('renders horizontal rules (---, ***, ___) to <hr class="bili-hr" />', () => {
    const md = '前言\n\n---\n\n后文';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<hr class="bili-hr" />'));
    assert.ok(!html.includes('<p>---</p>'));
  });

  it('renders bold, links, and code inside blockquotes', () => {
    const md = '> 📅 **发布时间**: 2026-08-18 | 🔗 **视频地址**: https://www.bilibili.com/video/BV1Vt8G6qEWk | 👤 **UP主**: 靖晨_2084';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<strong>发布时间</strong>: 2026-08-18'));
    assert.ok(html.includes('<strong>视频地址</strong>: <a href="https://www.bilibili.com/video/BV1Vt8G6qEWk"'));
    assert.ok(html.includes('<strong>UP主</strong>: 靖晨_2084'));
    assert.ok(!html.includes('**发布时间**'));
  });

  it('renders markdown tables correctly', () => {
    const md = `| 维度 | 主张 | 验证 |\n| --- | --- | --- |\n| 成本 | 200元 | 真实 |`;
    const html = renderMarkdown(md);

    assert.ok(html.includes('<table class="bili-table">'));
    assert.ok(html.includes('<th>维度</th>'));
    assert.ok(html.includes('<td>200元</td>'));
  });

  it('wraps mermaid code blocks in dedicated container', () => {
    const md = '```mermaid\nflowchart TD\nA["核心主张"] --> B["实测证据"]\n```';
    const html = renderMarkdown(md);

    assert.ok(html.includes('class="bili-mermaid"'));
    assert.ok(html.includes('flowchart TD'));
  });

  it('renders CJK bold correctly even when containing trailing spaces or punctuation', () => {
    const md = '**231 条弹幕中 209 条（90%） **集中在 [00:00-00:30]';
    const html = renderMarkdown(md);

    assert.ok(html.includes('<strong>231 条弹幕中 209 条（90%）</strong>'));
    assert.ok(!html.includes('**231'));
  });

  it('escapes dangerous HTML script tags to prevent XSS', () => {
    const md = '<script>alert("xss")</script>';
    const html = renderMarkdown(md);

    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });
});
