/**
 * 轻量级安全 Markdown 渲染模块
 */

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatInline(str) {
  if (!str) return '';
  let res = str;

  // 1. 行内代码
  res = res.replace(/`([^`]+)`/g, '<code>$1</code>');

  // 2. 粗体与斜体（自动清理 LLM 输出的空格与标点边界）
  res = res.replace(/\*\*([^\*\n]+?)\*\*/g, (m, p1) => {
    const trimmed = p1.trim();
    return trimmed ? `<strong>${trimmed}</strong>` : m;
  });
  res = res.replace(/\*([^\*\n]+?)\*/g, (m, p1) => {
    const trimmed = p1.trim();
    return trimmed ? `<em>${trimmed}</em>` : m;
  });

  // 3. Markdown 链接 [text](url)
  res = res.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // 4. 裸 URL 自动转链接 (未被 a 标签包裹的 URL)
  res = res.replace(/(^|[\s(（>])(https?:\/\/[a-zA-Z0-9-._~:/?#[\]@!$&'*+,;=%]+)(?=$|[\s)）<])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  return res;
}

export function renderMarkdown(markdown) {
  if (!markdown || typeof markdown !== 'string') return '';

  // 1. 处理代码块（含 mermaid）
  const codeBlocks = [];
  let text = markdown.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_${codeBlocks.length}__`;
    const escapedCode = escapeHtml(code.trim());
    if (lang.toLowerCase() === 'mermaid') {
      codeBlocks.push(`<div class="bili-mermaid"><pre class="mermaid">${escapedCode}</pre></div>`);
    } else {
      codeBlocks.push(`<pre><code class="language-${lang}">${escapedCode}</code></pre>`);
    }
    return placeholder;
  });

  // 2. 行内转义与基础语法
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>');
      inTable = false;
    }
  };

  for (let rawLine of lines) {
    let line = rawLine;

    // 占位符跳过转义
    if (line.startsWith('__CODE_BLOCK_')) {
      closeList();
      closeTable();
      out.push(line);
      continue;
    }

    const trimmed = line.trim();

    // 分割线 (---, ***, ___)
    if (/^(\s*[-*_]\s*){3,}$/.test(trimmed)) {
      closeList();
      closeTable();
      out.push('<hr class="bili-hr" />');
      continue;
    }

    line = escapeHtml(line);

    // 标题
    if (/^### (.*$)/.test(line)) {
      closeList();
      closeTable();
      out.push(`<h3>${formatInline(line.replace(/^### (.*$)/, '$1'))}</h3>`);
      continue;
    }
    if (/^## (.*$)/.test(line)) {
      closeList();
      closeTable();
      out.push(`<h2>${formatInline(line.replace(/^## (.*$)/, '$1'))}</h2>`);
      continue;
    }
    if (/^# (.*$)/.test(line)) {
      closeList();
      closeTable();
      out.push(`<h1>${formatInline(line.replace(/^# (.*$)/, '$1'))}</h1>`);
      continue;
    }

    // 引用块 (支持行内粗体、链接、代码)
    if (/^&gt; (.*$)/.test(line)) {
      closeList();
      closeTable();
      const quoteContent = line.replace(/^&gt; (.*$)/, '$1');
      out.push(`<blockquote>${formatInline(quoteContent)}</blockquote>`);
      continue;
    }

    // 表格识别 (| col1 | col2 |)
    if (/^\|(.+)\|$/.test(trimmed)) {
      closeList();
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      // 分隔行 (e.g. |---|---|)
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      if (!inTable) {
        inTable = true;
        out.push('<table class="bili-table"><thead><tr>');
        cells.forEach((c) => {
          out.push(`<th>${formatInline(escapeHtml(c))}</th>`);
        });
        out.push('</tr></thead><tbody>');
      } else {
        out.push('<tr>');
        cells.forEach((c) => {
          out.push(`<td>${formatInline(escapeHtml(c))}</td>`);
        });
        out.push('</tr>');
      }
      continue;
    } else {
      closeTable();
    }

    // 无序列表
    if (/^[-*] (.*$)/.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      const listContent = line.replace(/^[-*] (.*$)/, '$1');
      out.push(`<li>${formatInline(listContent)}</li>`);
      continue;
    } else {
      closeList();
    }

    // 普通段落
    if (line.trim()) {
      out.push(`<p>${formatInline(line)}</p>`);
    }
  }

  closeList();
  closeTable();

  let finalHtml = out.join('\n');

  // 还原代码块
  codeBlocks.forEach((block, idx) => {
    finalHtml = finalHtml.replace(`__CODE_BLOCK_${idx}__`, block);
  });

  return finalHtml;
}
