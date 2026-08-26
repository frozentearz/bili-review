// ==UserScript==
// @name         Bilibili 视频深度研报总结 (bili-review 2.0)
// @namespace    https://clawhub.ai/frozentearz/skills/bili-review
// @version      2.1.1
// @description  边刷B站边看AI深度研报！双源交叉检视（字幕观点 + 楼中楼实测证据），右侧悬浮Dock多任务队列与 Markdown 研报阅读器。支持 F/Esc 键全屏控制与拖拽定宽。
// @author       Frazier
// @match        *://*.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @connect      127.0.0.1
// @connect      localhost
// @connect      api.bilibili.com
// @connect      *.bilibili.com
// @connect      *.hdslb.com
// @connect      *.bilivideo.com
// @require      https://cdn.jsdelivr.net/npm/marked/marked.min.js
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ==========================================
  // 0. GM 与 LocalStorage 双通道持久化桥接
  // ==========================================
  function gmStorageGet(key, def = null) {
    try {
      if (typeof GM_getValue === 'function') {
        const val = GM_getValue(key);
        if (val !== undefined && val !== null) return val;
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const v = localStorage.getItem('GM_' + key) || localStorage.getItem(key);
        if (v !== null && v !== undefined) return v;
      }
    } catch {}
    return def;
  }

  function gmStorageSet(key, val) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, val);
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem('GM_' + key, val);
      }
    } catch {}
  }

  // ==========================================
  // 1. 配置管理与动态模型拉取
  // ==========================================
  const DEFAULT_CONFIG = {
    provider: 'Anthropic',
    baseUrl: 'http://127.0.0.1:62999',
    apiKey: '',
    defaultModel: 'claude-3-7-sonnet-20250219',
    targetModel: 'claude-opus-4-8',
    activeModel: 'claude-opus-4-8',
    maxTokens: 4096
  };

  function getConfig() {
    try {
      const saved = gmStorageGet('bili_review_config');
      return saved ? { ...DEFAULT_CONFIG, ...(typeof saved === 'string' ? JSON.parse(saved) : saved) } : DEFAULT_CONFIG;
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  function saveConfig(cfg) {
    gmStorageSet('bili_review_config', JSON.stringify(cfg));
  }

  async function pullAvailableModels() {
    const cfg = getConfig();
    try {
      const resRaw = await gmFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cfg.apiKey}`,
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 5000
      });
      const resJson = JSON.parse(resRaw);
      const models = Array.isArray(resJson.data) ? resJson.data.map((m) => m.id) : [];

      if (models.includes(cfg.targetModel)) {
        cfg.activeModel = cfg.targetModel;
      } else if (models.length > 0) {
        cfg.activeModel = models[0];
      }
      saveConfig(cfg);
      updateModelTag();
    } catch (e) {
      console.warn('[bili-review] 动态拉取模型失败，使用默认配置:', e);
    }
  }

  // ==========================================
  // 2. 状态机与持久化存储 (TaskStore)
  // ==========================================
  const TaskStatus = {
    PENDING: 'pending',
    EXTRACTING: 'extracting',
    SUMMARIZING: 'summarizing',
    COMPLETED: 'completed',
    FAILED: 'failed'
  };

  class TaskStore {
    constructor() {
      this.tasks = new Map();
      this.listeners = new Set();
      this.load();
    }

    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    notify() {
      this.save();
      this.listeners.forEach((fn) => fn(this.listTasks()));
    }

    createTask(bvid, meta = {}) {
      const existing = this.tasks.get(bvid);
      if (existing && existing.status === TaskStatus.COMPLETED) {
        return existing;
      }
      const task = {
        bvid,
        title: meta.title || bvid,
        author: meta.author || '',
        pic: meta.pic || '',
        pubdate: meta.pubdate || '',
        status: TaskStatus.PENDING,
        progress: '排队等待...',
        summary: '',
        error: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      this.tasks.set(bvid, task);
      this.notify();
      return task;
    }

    updateTask(bvid, updates = {}) {
      const task = this.tasks.get(bvid);
      if (!task) return null;
      Object.assign(task, updates, { updatedAt: Date.now() });
      this.notify();
      return task;
    }

    getTask(bvid) {
      return this.tasks.get(bvid) || null;
    }

    listTasks() {
      return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    }

    deleteTask(bvid) {
      const res = this.tasks.delete(bvid);
      if (res) this.notify();
      return res;
    }

    clear() {
      this.tasks.clear();
      this.notify();
    }

    save() {
      try {
        const data = Array.from(this.tasks.entries());
        gmStorageSet('bili_review_tasks_v2', JSON.stringify(data));
      } catch (e) {
        console.error('[bili-review] 保存任务缓存失败:', e);
      }
    }

    load() {
      try {
        let raw = gmStorageGet('bili_review_tasks_v2');
        if (!raw) {
          // 向上兼容与迁移旧版存储数据
          raw = gmStorageGet('bili_review_tasks') || gmStorageGet('bili_tasks');
        }
        if (raw) {
          const entries = typeof raw === 'string' ? JSON.parse(raw) : raw;
          if (Array.isArray(entries)) {
            this.tasks = new Map(entries);
          } else if (typeof entries === 'object' && entries !== null) {
            this.tasks = new Map(Object.entries(entries));
          }
        }
      } catch (e) {
        console.error('[bili-review] 加载任务缓存失败:', e);
      }
    }
  }

  const store = new TaskStore();
  if (typeof window !== 'undefined') window.__biliReviewStore = store;

  // ==========================================
  // 3. 数据抽取与 B 站 API
  // ==========================================
  function parseBvidFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const match = url.match(/BV[a-zA-Z0-9]{10}/i);
    return match ? match[0] : null;
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return '未知时间';
    const ms = timestamp > 1e11 ? timestamp : timestamp * 1000;
    const date = new Date(ms);
    if (isNaN(date.getTime())) return '未知时间';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatSecondsToTime(seconds) {
    const s = Math.floor(Number(seconds) || 0);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `[${mm}:${ss}]`;
  }

  function normalizeComment(c) {
    return {
      uname: c?.member?.uname || '匿名用户',
      message: (c?.content?.message || '').replace(/\r?\n/g, ' '),
      like: c?.like || 0,
      date: formatTimestamp(c?.ctime),
      replies: Array.isArray(c?.replies) ? c.replies.map(normalizeComment) : []
    };
  }

  async function gmFetch(url, options = {}) {
    const timeoutMs = options.timeout || 15000;

    // 1. 优先采用浏览器原生 fetch（同域/B站子域免授权，极速直达且自动附带登录态）
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const fetchOpts = {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body || null,
        signal: controller.signal,
        credentials: url.includes('bilibili.com') ? 'include' : 'same-origin'
      };
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 300) {
        return await res.text();
      }
    } catch (fetchErr) {
      // 若原生 fetch 遇到跨域或网络问题，自动降级至 GM_xmlhttpRequest
    }

    // 2. 降级方案：GM_xmlhttpRequest（用于跨源请求）
    return new Promise((resolve, reject) => {
      let isSettled = false;
      const watchdogTimer = setTimeout(() => {
        if (!isSettled) {
          isSettled = true;
          reject(new Error(`网络请求超时 (${timeoutMs}ms): ${url.slice(0, 60)}`));
        }
      }, timeoutMs);

      try {
        if (typeof GM_xmlhttpRequest === 'undefined') {
          clearTimeout(watchdogTimer);
          return reject(new Error('无可用网络请求接口'));
        }
        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          headers: options.headers || {},
          data: options.body || null,
          timeout: timeoutMs,
          onload: (res) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(watchdogTimer);
            if (res.status >= 200 && res.status < 300) {
              resolve(res.responseText);
            } else {
              reject(new Error(`HTTP ${res.status}: ${res.responseText.slice(0, 150)}`));
            }
          },
          onerror: (err) => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(watchdogTimer);
            reject(new Error('网络请求错误: ' + JSON.stringify(err)));
          },
          ontimeout: () => {
            if (isSettled) return;
            isSettled = true;
            clearTimeout(watchdogTimer);
            reject(new Error(`网络请求超时 (${timeoutMs}ms)`));
          }
        });
      } catch (e) {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(watchdogTimer);
          reject(e);
        }
      }
    });
  }

  async function fetchBiliVideoData(bvid) {
    // 1. 抓取视频核心元数据（带 8 秒超时保护）
    const viewRaw = await gmFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { timeout: 8000 });
    const viewJson = JSON.parse(viewRaw);
    if (viewJson.code !== 0) throw new Error(viewJson.message || '获取视频详情失败');

    const data = viewJson.data;
    const cid = data.cid;
    const aid = data.aid;
    const videoInfo = {
      bvid,
      aid,
      cid,
      title: data.title,
      author: data.owner?.name || '',
      pubdate: formatTimestamp(data.pubdate),
      pic: data.pic,
      desc: data.desc || ''
    };

    // 2. 抓取字幕（带 6 秒隔离超时保护，失败或无字幕平滑跳过）
    let subtitleText = '';
    try {
      const playerRaw = await gmFetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { timeout: 6000 });
      const playerJson = JSON.parse(playerRaw);
      const subList = playerJson.data?.subtitle?.subtitles || [];
      if (subList.length > 0) {
        let subUrl = subList[0].subtitle_url;
        if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
        const subContentRaw = await gmFetch(subUrl, { timeout: 6000 });
        const subData = JSON.parse(subContentRaw);
        if (Array.isArray(subData.body)) {
          subtitleText = subData.body
            .map((item) => `${formatSecondsToTime(item.from)} ${item.content || ''}`.trim())
            .filter(Boolean)
            .join('\n');
        }
      }
    } catch (e) {
      console.warn('[bili-review] 字幕提取未获取或超时，使用视频简介作为备选:', e.message);
    }

    // 2.5 抓取弹幕并进行时序分析（带 6 秒隔离超时保护）
    let danmakuSummary = '';
    try {
      const danmakuRaw = await gmFetch(`https://comment.bilibili.com/${cid}.xml`, { timeout: 6000 });
      const danmakuList = parseDanmakuXml(danmakuRaw);
      if (danmakuList.length > 0) {
        const analysis = analyzeDanmaku(danmakuList);
        danmakuSummary = formatDanmakuSummary(analysis);
      }
    } catch (e) {
      console.warn('[bili-review] 弹幕提取未获取或超时:', e.message);
    }

    // 3. 抓取评论与楼中楼（带 6 秒隔离超时保护）
    let commentsText = '';
    try {
      const replyRaw = await gmFetch(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=3&ps=15`, { timeout: 6000 });
      const replyJson = JSON.parse(replyRaw);
      const rawReplies = replyJson.data?.replies || [];
      const lines = [];

      rawReplies.forEach((raw, idx) => {
        const c = normalizeComment(raw);
        lines.push(`${idx + 1}. [${c.date}] [点赞 ${c.like}] ${c.uname}: ${c.message}`);
        if (c.replies.length > 0) {
          c.replies.forEach((sub, subIdx) => {
            lines.push(`   └ 楼中楼${subIdx + 1}. [${sub.date}] [点赞 ${sub.like}] ${sub.uname}: ${sub.message}`);
          });
        }
      });
      commentsText = lines.join('\n');
    } catch (e) {
      console.warn('[bili-review] 评论提取超时或失败:', e.message);
    }

    return { videoInfo, subtitleText, danmakuSummary, commentsText };
  }
  if (typeof window !== 'undefined') window.__fetchBiliVideoData = fetchBiliVideoData;

  // ==========================================
  // 3.5 弹幕解析与时序特征抽取引擎
  // ==========================================
  function parseDanmakuXml(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const list = [];
    const regex = /<d\s+p="([^"]+)">([\s\S]*?)<\/d>/g;
    let match;
    while ((match = regex.exec(xmlText)) !== null) {
      const rawAttr = match[1];
      const text = match[2].trim();
      if (!text) continue;
      const parts = rawAttr.split(',');
      const time = parseFloat(parts[0]) || 0;
      const dmid = parts[7] || '';
      list.push({ time, text, dmid });
    }
    return list.sort((a, b) => a.time - b.time);
  }

  function analyzeDanmaku(danmakuList, options = {}) {
    if (!Array.isArray(danmakuList) || danmakuList.length === 0) {
      return { total: 0, highlights: [], corrections: [] };
    }
    const bucketSeconds = options.bucketSeconds || 30;
    const topSpikes = options.topSpikes || 5;
    const buckets = new Map();
    const correctionKeywords = ['错', '避坑', '翻车', '其实', '注意', '假', 'bug', '骗', '误导', '不建议', '千万别', '坑'];
    const corrections = [];

    danmakuList.forEach((d) => {
      const bucketIndex = Math.floor(d.time / bucketSeconds);
      const startSec = bucketIndex * bucketSeconds;

      if (!buckets.has(bucketIndex)) {
        buckets.set(bucketIndex, {
          bucketIndex,
          startTime: startSec,
          endTime: startSec + bucketSeconds,
          count: 0,
          texts: []
        });
      }

      const b = buckets.get(bucketIndex);
      b.count += 1;
      b.texts.push(d.text);

      const isCorrection = correctionKeywords.some((kw) => d.text.includes(kw));
      if (isCorrection && corrections.length < 15) {
        corrections.push({
          time: d.time,
          timeFormatted: formatSecondsToTime(d.time),
          text: d.text
        });
      }
    });

    const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
    const highlights = sortedBuckets.slice(0, topSpikes).map((b) => {
      const startFmt = formatSecondsToTime(b.startTime).replace(/[\[\]]/g, '');
      const endFmt = formatSecondsToTime(b.endTime).replace(/[\[\]]/g, '');
      const wordFreq = {};
      b.texts.forEach((txt) => {
        const clean = txt.replace(/[\s,.!?;:，。！？；：~～]+/g, '');
        if (clean.length >= 2) {
          wordFreq[clean] = (wordFreq[clean] || 0) + 1;
        }
      });
      const topBuzzwords = Object.entries(wordFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([word]) => word);
      return {
        startTime: b.startTime,
        endTime: b.endTime,
        timeRange: `[${startFmt} - ${endFmt}]`,
        count: b.count,
        topBuzzwords,
        samples: b.texts.slice(0, 3)
      };
    });

    return {
      total: danmakuList.length,
      highlights,
      corrections
    };
  }

  function formatDanmakuSummary(analysis) {
    if (!analysis || !analysis.total) return '暂无弹幕时序数据';
    const lines = [`- 弹幕总量: ${analysis.total} 条`];
    if (analysis.highlights && analysis.highlights.length > 0) {
      lines.push('\n【高能时序峰值 TOP】:');
      analysis.highlights.forEach((h, idx) => {
        const buzz = h.topBuzzwords && h.topBuzzwords.length > 0 ? ` (热词: ${h.topBuzzwords.map((w) => `"${w}"`).join(', ')})` : '';
        lines.push(`${idx + 1}. ${h.timeRange} 弹幕密度: ${h.count}条${buzz}`);
        if (h.samples && h.samples.length > 0) {
          lines.push(`   └ 典型弹幕: ${h.samples.map((s) => `"${s}"`).join(' | ')}`);
        }
      });
    }
    if (analysis.corrections && analysis.corrections.length > 0) {
      lines.push('\n【即时纠错 / 避坑预警 / 关键弹幕】:');
      analysis.corrections.forEach((c) => {
        lines.push(`- ${c.timeFormatted} ${c.text}`);
      });
    }
    return lines.join('\n');
  }

  // ==========================================
  // 4. Prompt 组装与官方 bili-review 2.1 规范
  // ==========================================
  function getSystemPrompt() {
    return `你是 B 站「三源情报研报」高级分析专家（bili-review 2.1 研报引擎）。
你的核心使命是通过整合【视频 AI 字幕（UP 主单方主张）】、【高能弹幕时序（群体情绪与即时纠错）】与【高赞/楼中楼评论（群众实测检验证据）】，交叉比对提炼高信度事实、本质洞察（So What）与行动指引（Actionable）。

【4 大自适应模型路由准则】：
根据视频的核心诉求，自动选定并强制路由至对应框架组织研报正文：
1. 评测 / 避坑 / 机制分析（软硬件测评、价格变动、游戏机制、踩坑实录）➔ 【正反合（辩证检验模型）】
   - 正（立论）：UP 主宣传点与核心优势
   - 反（反驳）：评论区与弹幕实测槽点/翻车真相/隐藏成本
   - 合（定性）：客观适用边界与终极选型结论
2. 教程 / 工作流 / 实操（技术教程、配置指南、效率工作流、操作指南）➔ 【5W2H 与 MEAT 原则】
   - 5W2H（Why/What/Who/When/Where/How/How Much）+ MEAT（Make 自研/Eliminate 废弃/Automate 自动化/Transform 流程重塑）
3. 观点 / 趋势 / 行业洞察（行业分析、商业模式、热点事件、技术前瞻）➔ 【SCQA 模型（金字塔原理）】
   - S（背景）+ C（冲突）+ Q（核心议题）+ A（战略解法与主张）
4. 科普 / 技术 / 原理解析（架构设计、算法解析、物理数学科普、底层原理）➔ 【演绎推理与抽象阶梯法】
   - 第一性原理 ➔ 下行推演 ➔ 具象锚定

【四大维度 10 项执行准则】：
- 信度（Reliability）：正确性（杜绝幻觉）、时效性（标注发布日期与半衰期）、客观性（剥离营销恰饭修辞）
- 构度（Structure）：完整性（MECE 原则，相互独立完全穷尽）、聚焦性（直指核心价值，拒绝废话）
- 达度（Communication）：可读性（大白话扫读，专业名词括号释义）、简洁性（单段 ≤3 行）、逻辑性（严密自洽）
- 效度（Impact & Action）：洞察性（穿透表象回答 So What？底层规律）、可执行性（明确推荐行动清单与避坑建议）

【排版铁律】：
1. 核心句式：每段均采用「**核心结论句** + 展开说明」结构，关键参数加粗。
2. 表格优先：涉及参数对比、优缺点比对、版本差异时，优先采用简洁 Markdown 小表格。
3. 文本独立自洽：正文文字必须 100% 独立自洽。选配的 Mermaid 图表节点文本必须使用英文双引号包裹。`;
  }

  function buildReviewPrompt(videoInfo, subtitleText, danmakuSummary, commentsText) {
    const title = videoInfo?.title || '未知视频';
    const author = videoInfo?.author || '未知UP主';
    const pubdate = videoInfo?.pubdate || '未知时间';
    const bvid = videoInfo?.bvid || '';
    const desc = videoInfo?.desc || '无简介';

    let danmakuSecText = '';
    let finalComments = '';

    if (commentsText !== undefined) {
      danmakuSecText = danmakuSummary || '';
      finalComments = commentsText || '';
    } else {
      finalComments = danmakuSummary || '';
    }

    const hasSubtitles = Boolean(subtitleText && subtitleText.trim());
    const contentSection = hasSubtitles
      ? subtitleText.trim()
      : `（该视频无官方/AI字幕，依据视频简介与元数据）\n简介内容：${desc}`;

    const safeComments = finalComments && finalComments.trim() ? finalComments.trim() : '暂无精选评论';

    const danmakuSection = danmakuSecText && danmakuSecText.trim()
      ? `\n=== 【弹幕时序热点与即时反馈】（群体情绪与时序证据） ===\n${danmakuSecText.trim()}\n`
      : '';

    return `请根据以下 B 站视频三源数据，严格按照 bili-review 2.1 输出契约规范生成一份结构化深度研报：

=== 视频元数据 ===
- 视频标题: ${title}
- UP主: ${author}
- 发布时间: ${pubdate}
- BV号: ${bvid}
- 视频链接: https://www.bilibili.com/video/${bvid}

=== 【视频字幕/文稿内容】（UP主单方主张） ===
${contentSection}
${danmakuSection}
=== 【评论区与楼中楼实测检验】（用户与实测证据） ===
${safeComments}

------------------------
【输出格式要求】：必须严格遵循以下标准 Markdown 契约模板交付：

# 《${title}》深度研报

> 📅 **发布时间**：${pubdate} ｜ ⏳ **时效半衰期**：[短期(30天内) / 中期(半年) / 长期(通用知识)]  
> 🧭 **分析框架**：[正反合 / 5W2H / SCQA / 演绎推理]（选定理由：一句话说明匹配依据）  
> 🔗 **视频地址**：https://www.bilibili.com/video/${bvid} ｜ 👤 **UP主**：${author}

---

## 1. 核心提炼（Executive Summary）
- **一句话结论**：用最精准的大白话给出视频核心定性。
- **核心数据/结论速览**：2~3 个带 **加粗核心事实** 的 bullet points。

---

## 2. 结构化深度剖析（基于选定框架）

<!-- 根据所选框架展开，例如：正反合 / 5W2H / SCQA / 演绎推理 -->
### [框架对应子模块 1]
- **核心要点**：展开说明（单段 ≤3 行）。
- **参数/方案对比**（如有表格）：
  | 方案 / 版本 | 核心优势 | 潜在瓶颈 / 成本 | 适用边界 |
  |---|---|---|---|
  | A | ... | ... | ... |

---

## 3. 多源信度交叉验证（字幕 vs 弹幕高能 vs 评论区）
- **UP 主单方主张**：视频宣称的核心优势或主要论点。
- **弹幕时序共识与即时纠错**：高能时刻观众情绪、实时反驳与避坑提醒（附带时间戳 [MM:SS]）。
- **评论区实测验证**：高赞/楼中楼反馈的真实体验、翻车案例或补充方案（附带评论时间与点赞数）。
- **交叉定性结论**：综合评定真实可靠性与已知边界。

---

## 4. 🔍 本质洞察（So What？）
- **底层逻辑**：穿透技术或现象表层的行业/架构/经济规律。
- **潜在风险与陷阱**：未被直接言明但必须防范的暗坑或连锁反应。

---

## 5. 🎯 行动指引（Actionable）
- [ ] **推荐行动**：立即可以执行的步骤 1、2、3。
- [ ] **避坑建议**：明确哪些场景切勿使用或需要规避的操作。
`;
  }

  async function callAnthropicApi(prompt) {
    const cfg = getConfig();
    const headers = {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'claude-code-20250219',
      'content-type': 'application/json',
      'x-app': 'cli',
      'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)'
    };

    const body = JSON.stringify({
      model: cfg.activeModel || cfg.targetModel || 'claude-opus-4-8',
      max_tokens: cfg.maxTokens || 4096,
      system: getSystemPrompt(),
      stream: false,
      messages: [{ role: 'user', content: prompt }]
    });

    const resText = await gmFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      timeout: 120000
    });

    const json = JSON.parse(resText);
    if (json.error) {
      throw new Error(json.error.message || 'API 请求被拒绝');
    }

    if (Array.isArray(json.content) && json.content.length > 0) {
      return json.content.map((c) => c.text || '').join('');
    }
    return resText;
  }

  async function executeSummaryTask(bvid, meta) {
    store.updateTask(bvid, {
      status: TaskStatus.EXTRACTING,
      progress: '提取字幕、弹幕与评论中...',
      error: ''
    });

    try {
      const { videoInfo, subtitleText, danmakuSummary, commentsText } = await fetchBiliVideoData(bvid);
      store.updateTask(bvid, {
        title: videoInfo.title,
        author: videoInfo.author,
        pic: videoInfo.pic,
        pubdate: videoInfo.pubdate,
        status: TaskStatus.SUMMARIZING,
        progress: 'Claude Opus 研判中...'
      });

      const prompt = buildReviewPrompt(videoInfo, subtitleText, danmakuSummary, commentsText);
      const summaryResult = await callAnthropicApi(prompt);

      store.updateTask(bvid, {
        status: TaskStatus.COMPLETED,
        progress: '已完成',
        summary: summaryResult
      });
    } catch (err) {
      console.error('[bili-review] 任务失败:', err);
      store.updateTask(bvid, {
        status: TaskStatus.FAILED,
        progress: '生成失败',
        error: err.message || String(err)
      });
    }
  }


  // ==========================================
  // 5. 安全转义与 Markdown 渲染引擎（基于 Marked GFM 工业级标准）
  // ==========================================
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(markdown) {
    if (!markdown || typeof markdown !== 'string') return '';

    // 1. 保护代码块与行内代码免受正则替换
    const codePlaceholders = [];
    let text = markdown.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
      const ph = `__PROTECTED_CODE_${codePlaceholders.length}__`;
      codePlaceholders.push(match);
      return ph;
    });

    // 2. 修复中文环境与全角标点导致的 CommonMark ** 粗体无法闭合/失效问题
    // （例如 "**231 条弹幕中 209 条（90%） **集中在" 或 "**提示：**内容"）
    text = text.replace(/\*\*([^\*\n]+?)\*\*/g, (m, p1) => {
      const trimmed = p1.trim();
      return trimmed ? `<strong>${trimmed}</strong>` : m;
    });

    // 3. 还原代码块
    codePlaceholders.forEach((code, idx) => {
      text = text.replace(`__PROTECTED_CODE_${idx}__`, code);
    });

    // 4. 交由 Marked 引擎标准渲染
    if (typeof marked !== 'undefined' && typeof marked.parse === 'function') {
      return marked.parse(text, {
        breaks: true,
        gfm: true
      });
    }

    return text;
  }

  // ==========================================
  // 6. UI 与交互样式
  // ==========================================
  const STYLES = `
    #bili-review-float-btn {
      position: fixed;
      right: 0;
      top: 45%;
      transform: translateY(-50%);
      background: linear-gradient(135deg, #00AEEC, #0084B6);
      color: #fff;
      padding: 10px 14px 10px 12px;
      border-radius: 20px 0 0 20px;
      cursor: pointer;
      z-index: 999990;
      box-shadow: 0 4px 16px rgba(0, 174, 236, 0.35);
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      user-select: none;
    }
    #bili-review-float-btn:hover {
      padding-left: 18px;
      box-shadow: 0 6px 20px rgba(0, 174, 236, 0.5);
    }
    #bili-review-badge {
      background: #00D084;
      color: #fff;
      font-size: 11px;
      border-radius: 10px;
      padding: 1px 6px;
      font-weight: 700;
      display: inline-block;
    }

    /* 抽屉 / Dock 主体容器 */
    #bili-review-drawer {
      position: fixed;
      right: -100vw;
      top: 0;
      width: 460px;
      max-width: 100vw;
      height: 100vh;
      background: rgba(255, 255, 255, 0.98);
      backdrop-filter: blur(24px);
      box-shadow: -8px 0 32px rgba(0, 0, 0, 0.15);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      transition: right 0.3s cubic-bezier(0.16, 1, 0.3, 1), width 0.25s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      color: #18191C;
      overscroll-behavior: contain;
      overscroll-behavior-y: contain;
    }
    #bili-review-drawer.resizing {
      transition: none !important;
      user-select: none !important;
    }
    #bili-review-drawer.open {
      right: 0;
    }
    #bili-review-drawer.fullscreen {
      width: 100vw !important;
      max-width: 100vw !important;
    }

    /* 左边缘拖拽手柄（10px 超宽感应区，零延迟跟手） */
    #bili-drawer-resizer {
      position: absolute;
      left: -5px;
      top: 0;
      bottom: 0;
      width: 10px;
      cursor: ew-resize;
      background: transparent;
      z-index: 1000;
      transition: background 0.15s;
    }
    #bili-drawer-resizer:hover, #bili-drawer-resizer.dragging {
      background: #00AEEC;
      box-shadow: 0 0 10px rgba(0, 174, 236, 0.8);
    }
    #bili-review-drawer.fullscreen #bili-drawer-resizer {
      display: none;
    }

    /* 顶部标题栏 */
    .bili-drawer-header {
      padding: 10px 14px;
      border-bottom: 1px solid #E3E5E7;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: #F6F7F8;
      flex-wrap: nowrap;
      min-width: 0;
    }
    .bili-drawer-title {
      font-size: 14px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      flex-shrink: 1;
      min-width: 0;
    }
    .bili-drawer-title span:first-child {
      white-space: nowrap;
      flex-shrink: 0;
    }
    .bili-model-tag {
      background: #E8F4FD;
      color: #00AEEC;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100px;
      display: inline-block;
      flex-shrink: 1;
    }
    .bili-drawer-actions {
      display: flex;
      align-items: center;
      gap: 5px;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* 1:1 还原带快捷键徽章的按钮样式 */
    .bili-header-pill-btn {
      background: #18191C;
      color: #E2E8F0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 4px 6px;
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      user-select: none;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .bili-header-pill-btn span {
      white-space: nowrap;
    }
    .bili-header-pill-btn:hover {
      background: #282C34;
      border-color: rgba(255, 255, 255, 0.25);
      color: #FFFFFF;
      transform: translateY(-1px);
    }
    .bili-header-pill-btn:active {
      transform: translateY(0);
    }
    .bili-kbd-badge {
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 4px;
      padding: 1px 4px;
      font-size: 10.5px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #10B981;
      line-height: 1.2;
      display: inline-block;
      white-space: nowrap;
    }

    .bili-header-icon-btn {
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 14px;
      padding: 4px 4px;
      border-radius: 6px;
      color: #61666D;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .bili-header-icon-btn:hover {
      background: #E3E5E7;
      color: #18191C;
    }

    /* 任务列表容器 */
    #bili-task-list-view {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overscroll-behavior: contain;
      overscroll-behavior-y: contain;
    }
    .bili-task-card {
      background: #FFFFFF;
      border: 1px solid #E3E5E7;
      border-radius: 10px;
      padding: 12px;
      display: flex;
      gap: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      position: relative;
    }
    .bili-task-card:hover {
      border-color: #00AEEC;
      box-shadow: 0 4px 12px rgba(0, 174, 236, 0.12);
      transform: translateY(-1px);
    }

    /* 卡片右上角就地防误触删除按钮 */
    .bili-task-del-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 22px;
      height: 22px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.05);
      border: 1px solid rgba(0, 0, 0, 0.08);
      color: #9499A0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-size: 12px;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 5;
    }
    .bili-task-del-btn:hover {
      background: rgba(220, 38, 38, 0.1);
      color: #DC2626;
      border-color: rgba(220, 38, 38, 0.25);
    }
    .bili-task-del-btn.confirm-active {
      width: auto !important;
      padding: 0 6px !important;
      background: #DC2626 !important;
      color: #FFFFFF !important;
      border-color: #DC2626 !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      box-shadow: 0 2px 8px rgba(220, 38, 38, 0.35);
    }

    .bili-task-cover {
      width: 100px;
      height: 62px;
      border-radius: 6px;
      object-fit: cover;
      background: #E3E5E7;
      flex-shrink: 0;
    }
    .bili-task-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding-right: 20px;
    }
    .bili-task-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: #18191C;
    }
    .bili-task-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 6px;
      gap: 6px;
      flex-wrap: nowrap;
      min-width: 0;
    }
    .bili-task-author {
      font-size: 11px;
      color: #9499A0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    /* 状态徽章 Badge - 变绿逻辑 */
    .bili-status-badge {
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .bili-status-badge.completed {
      background: #E6F7ED !important;
      color: #1A7F37 !important;
      border: 1px solid #A8D5BA !important;
    }
    .bili-status-badge.summarizing {
      background: #F0E8FF;
      color: #7B2CBF;
      border: 1px solid #D8B4FE;
      animation: bili-pulse 1.5s infinite;
    }
    .bili-status-badge.extracting, .bili-status-badge.pending {
      background: #FFF8E6;
      color: #B45309;
      border: 1px solid #FCD34D;
    }
    .bili-status-badge.failed {
      background: #FEE2E2;
      color: #DC2626;
      border: 1px solid #FCA5A5;
    }

    /* 开发者测试用：重新调研按钮 */
    .bili-dev-retry-btn {
      background: #F1F2F3;
      border: 1px solid #E3E5E7;
      color: #61666D;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .bili-dev-retry-btn:hover {
      background: #00AEEC;
      color: #FFF;
      border-color: #00AEEC;
    }

    @keyframes bili-pulse {
      0% { opacity: 0.7; }
      50% { opacity: 1; }
      100% { opacity: 0.7; }
    }

    #bili-summary-detail-view {
      flex: 1;
      overflow-y: auto;
      padding: 0 30px 30px 30px;
      display: none;
      overscroll-behavior: contain;
      overscroll-behavior-y: contain;
    }
    .bili-detail-toolbar {
      position: sticky;
      top: 0;
      margin: 0 -30px 16px -30px;
      padding: 12px 30px;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(20px);
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #E3E5E7;
      z-index: 50;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
    }
    .bili-back-btn {
      background: #F1F2F3;
      border: 1px solid #E3E5E7;
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      color: #18191C;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bili-back-btn:hover {
      background: #00AEEC;
      color: #fff;
      border-color: #00AEEC;
      box-shadow: 0 2px 8px rgba(0, 174, 236, 0.3);
      transform: translateY(-1px);
    }
    .bili-article-actions {
      display: flex;
      gap: 8px;
    }
    .bili-action-btn {
      background: #F1F2F3;
      border: 1px solid #E3E5E7;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      color: #18191C;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .bili-action-btn:hover {
      background: #E3E5E7;
      color: #00AEEC;
      border-color: #00AEEC;
      transform: translateY(-1px);
    }
    .bili-action-btn.dev-btn {
      color: #B45309;
      border-color: #FCD34D;
      background: #FFF8E6;
    }
    .bili-action-btn.dev-btn:hover {
      background: #B45309;
      color: #FFF;
      border-color: #B45309;
    }

    .bili-markdown-body {
      font-size: 14px;
      line-height: 1.7;
      color: #222;
      max-width: 900px;
      margin: 0 auto;
      word-wrap: break-word;
    }
    .bili-markdown-body p {
      margin: 10px 0;
    }
    .bili-markdown-body h1 {
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 16px 0;
      color: #00AEEC;
      border-bottom: 2px solid #E8F4FD;
      padding-bottom: 8px;
    }
    .bili-markdown-body h2 {
      font-size: 16px;
      font-weight: 700;
      margin: 24px 0 12px 0;
      color: #18191C;
      display: flex;
      align-items: center;
      gap: 6px;
      border-bottom: 1px solid #F1F2F3;
      padding-bottom: 6px;
    }
    .bili-markdown-body h3 {
      font-size: 14.5px;
      font-weight: 600;
      margin: 16px 0 8px 0;
      color: #18191C;
    }
    .bili-markdown-body h4,
    .bili-markdown-body h5,
    .bili-markdown-body h6 {
      font-size: 13.5px;
      font-weight: 600;
      margin: 12px 0 6px 0;
      color: #333;
    }
    .bili-markdown-body blockquote {
      margin: 12px 0;
      padding: 10px 14px;
      background: #F6F7F8;
      border-left: 4px solid #00AEEC;
      border-radius: 0 6px 6px 0;
      color: #61666D;
      font-size: 13px;
    }
    .bili-markdown-body blockquote p {
      margin: 6px 0;
    }
    .bili-markdown-body blockquote p:first-child {
      margin-top: 0;
    }
    .bili-markdown-body blockquote p:last-child {
      margin-bottom: 0;
    }
    .bili-markdown-body a {
      color: #00AEEC;
      text-decoration: none;
      word-break: break-all;
      transition: color 0.2s;
    }
    .bili-markdown-body a:hover {
      color: #0084B6;
      text-decoration: underline;
    }
    .bili-markdown-body hr,
    .bili-markdown-body hr.bili-hr {
      border: none;
      border-top: 1px solid #E3E5E7;
      margin: 20px 0;
    }
    .bili-markdown-body table,
    .bili-markdown-body table.bili-table {
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 13px;
      line-height: 1.6;
      border: 1px solid #E3E5E7;
      border-radius: 6px;
      display: block;
      overflow-x: auto;
    }
    .bili-markdown-body table th,
    .bili-markdown-body table td,
    .bili-markdown-body table.bili-table th,
    .bili-markdown-body table.bili-table td {
      border: 1px solid #E3E5E7 !important;
      padding: 10px 14px;
      text-align: left;
      vertical-align: top;
    }
    .bili-markdown-body table th,
    .bili-markdown-body table.bili-table th {
      background: #F6F7F8 !important;
      font-weight: 700;
      color: #18191C;
      white-space: nowrap;
    }
    .bili-markdown-body table tr:nth-child(even),
    .bili-markdown-body table.bili-table tr:nth-child(even) {
      background: #FAFAFA;
    }
    .bili-markdown-body table tr:hover {
      background: #F0F9FF;
    }
    .bili-markdown-body code {
      background: #F1F2F3;
      color: #E03E2D;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    .bili-markdown-body ul {
      margin: 10px 0;
      padding-left: 24px;
      list-style-type: disc !important;
    }
    .bili-markdown-body ol {
      margin: 10px 0;
      padding-left: 24px;
      list-style-type: decimal !important;
    }
    .bili-markdown-body ul ul {
      list-style-type: circle !important;
    }
    .bili-markdown-body ol ol {
      list-style-type: lower-alpha !important;
    }
    .bili-markdown-body li {
      margin: 5px 0;
    }
    .bili-markdown-body input[type="checkbox"] {
      margin: 0 6px 0 0;
      vertical-align: middle;
      accent-color: #00AEEC;
    }
    .bili-markdown-body li:has(input[type="checkbox"]) {
      list-style-type: none !important;
      margin-left: -16px;
    }
    .bili-markdown-body strong {
      color: #000;
      font-weight: 700;
    }
    .bili-markdown-body em {
      font-style: italic;
    }
    .bili-markdown-body del,
    .bili-markdown-body s {
      color: #9499A0;
      text-decoration: line-through;
    }
    .bili-markdown-body img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 12px 0;
    }
    .bili-markdown-body pre {
      background: #282C34;
      color: #ABB2BF;
      padding: 14px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 12.5px;
      line-height: 1.5;
      margin: 14px 0;
    }
    .bili-markdown-body pre code {
      background: transparent;
      color: inherit;
      padding: 0;
    }

    /* 视频卡片右上角【总结】按钮（1:1 像素级复刻原生 B 站「稍后再看」22px 图标与 14px 字体） */
    .bili-review-card-btn {
      position: absolute;
      top: 40px;
      right: 8px;
      height: 28px;
      min-width: 28px;
      max-width: 28px;
      background: rgba(33, 33, 33, 0.8);
      backdrop-filter: blur(4px);
      color: #FFFFFF;
      border: none;
      border-radius: 6px;
      padding: 0 3px;
      cursor: pointer;
      z-index: 25 !important;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      transition: max-width 0.25s cubic-bezier(0.4, 0, 0.2, 1), background 0.2s, padding 0.25s, opacity 0.2s, box-shadow 0.2s;
      opacity: 0;
      pointer-events: none;
      box-sizing: border-box;
      overflow: hidden;
      white-space: nowrap;
    }
    /* 隐形交互热区桥接：防止鼠标在两个按钮间或视频预览加载时发生 1 帧落空 */
    .bili-review-card-btn::before {
      content: '';
      position: absolute;
      top: -6px;
      bottom: -6px;
      left: -15px;
      right: -6px;
      z-index: -1;
    }
    .bili-video-card__wrap:hover .bili-review-card-btn,
    .bili-video-card:hover .bili-review-card-btn,
    .feed-card:hover .bili-review-card-btn,
    .video-card:hover .bili-review-card-btn,
    .bili-video-card__image--wrap:hover .bili-review-card-btn,
    .bili-video-card__image:hover .bili-review-card-btn,
    .pic-box:hover .bili-review-card-btn {
      opacity: 1;
      pointer-events: auto;
    }
    .bili-review-card-btn:hover {
      max-width: 120px;
      padding: 0 6px 0 3px;
      background: rgba(33, 33, 33, 0.92);
      color: #FFFFFF;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      pointer-events: auto;
      opacity: 1;
    }
    .bili-review-card-btn.active {
      opacity: 1;
      pointer-events: auto;
      background: #1A7F37;
    }
    .bili-review-card-btn svg {
      width: 22px;
      height: 22px;
      min-width: 22px;
      fill: currentColor;
      flex-shrink: 0;
      margin: 0;
    }
    .bili-review-card-btn .bili-review-btn-text {
      font-family: "PingFang SC", HarmonyOS_Regular, "Helvetica Neue", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      font-weight: 400;
      line-height: 18px;
      letter-spacing: normal;
      color: #FFFFFF;
      margin-left: 4px;
      opacity: 0;
      transform: translateX(4px);
      transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1) 0.05s, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1) 0.05s;
      white-space: nowrap;
      user-select: none;
    }
    .bili-review-card-btn:hover .bili-review-btn-text {
      opacity: 1;
      transform: translateX(0);
    }

    .bili-review-toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(24, 25, 28, 0.9);
      color: #FFF;
      padding: 10px 20px;
      border-radius: 24px;
      font-size: 13px;
      font-weight: 500;
      z-index: 9999999;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
    }
  `;

  function showToast(msg) {
    const existing = document.querySelector('.bili-review-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'bili-review-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  function updateModelTag() {
    const tag = document.querySelector('.bili-model-tag');
    if (tag) tag.textContent = getConfig().activeModel || getConfig().targetModel;
  }

  // ==========================================
  // 7. UI 初始化与事件驱动
  // ==========================================
  let activeDetailBvid = null;
  let isDockFullscreen = false;
  let savedDockWidth = '460px';

  function initUI() {
    savedDockWidth = gmStorageGet('bili_review_dock_width', '460px');

    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    const floatBtn = document.createElement('div');
    floatBtn.id = 'bili-review-float-btn';
    floatBtn.innerHTML = `<span>📑 研报列表</span><span id="bili-review-badge">0</span>`;
    document.body.appendChild(floatBtn);

    const drawer = document.createElement('div');
    drawer.id = 'bili-review-drawer';
    drawer.style.width = savedDockWidth;
    drawer.innerHTML = `
      <div id="bili-drawer-resizer" title="拖动调整列表宽度"></div>
      <div class="bili-drawer-header">
        <div class="bili-drawer-title">
          <span>📊 深度研报</span>
          <span class="bili-model-tag" title="${getConfig().activeModel || getConfig().targetModel}">${getConfig().activeModel || getConfig().targetModel}</span>
        </div>
        <div class="bili-drawer-actions">
          <button class="bili-header-icon-btn" id="bili-clear-btn" title="清空所有记录">🗑️</button>
          <button class="bili-header-pill-btn" id="bili-fullscreen-btn" title="全屏 / 还原 (按 F 键)">
            <svg id="bili-fullscreen-icon" viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/>
            </svg>
            <span id="bili-fullscreen-text">全屏</span>
            <kbd class="bili-kbd-badge">F</kbd>
          </button>
          <button class="bili-header-pill-btn" id="bili-close-btn" title="收起列表 (按 Esc 键)">
            <span style="font-size: 13px; line-height: 1;">✕</span>
            <span id="bili-close-text">关闭</span>
            <kbd class="bili-kbd-badge">Esc</kbd>
          </button>
        </div>
      </div>
      <div id="bili-task-list-view"></div>
      <div id="bili-summary-detail-view">
        <div class="bili-detail-toolbar">
          <button class="bili-back-btn" id="bili-back-to-list-btn">← 返回列表</button>
          <div class="bili-article-actions">
            <button class="bili-action-btn dev-btn" id="bili-dev-resummarize-btn" title="仅供开发者测试：重新抓取并生成研报">🔄 重新调研</button>
            <button class="bili-action-btn" id="bili-copy-md-btn">📋 复制 Markdown</button>
          </div>
        </div>
        <div class="bili-markdown-body" id="bili-detail-content"></div>
      </div>
    `;
    document.body.appendChild(drawer);

    // 滚轮隔离
    drawer.addEventListener('wheel', (e) => {
      e.stopPropagation();
    }, { passive: true });

    // 浮动按钮点击
    floatBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDock();
    });

    // 顶部操作
    document.getElementById('bili-fullscreen-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });

    document.getElementById('bili-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDock();
    });

    document.getElementById('bili-clear-btn').addEventListener('click', () => {
      if (confirm('确定要清空所有已生成的研报记录吗？')) {
        store.clear();
        switchView('list');
      }
    });

    document.getElementById('bili-back-to-list-btn').addEventListener('click', () => {
      switchView('list');
    });

    document.getElementById('bili-copy-md-btn').addEventListener('click', () => {
      if (!activeDetailBvid) return;
      const task = store.getTask(activeDetailBvid);
      if (task && task.summary) {
        navigator.clipboard.writeText(task.summary).then(() => {
          showToast('✅ 研报 Markdown 已复制到剪贴板');
        });
      }
    });

    // 开发者重新调研按钮（正文工具栏）
    document.getElementById('bili-dev-resummarize-btn').addEventListener('click', () => {
      if (!activeDetailBvid) return;
      const bvid = activeDetailBvid;
      const task = store.getTask(bvid);
      if (task) {
        showToast(`🔄 正在重新调研《${(task.title || bvid).slice(0, 10)}...》`);
        executeSummaryTask(bvid, task);
        switchView('list');
      }
    });

    // 点击主页空白处自动收起
    document.addEventListener('click', (e) => {
      if (!drawer.classList.contains('open')) return;
      if (
        drawer.contains(e.target) ||
        floatBtn.contains(e.target) ||
        e.target.closest('.bili-review-card-btn')
      ) {
        return;
      }
      closeDock();
    });

    // 全局快捷键 F 与 Esc 状态机
    document.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }

      if (e.key === 'f' || e.key === 'F') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();

        if (!drawer.classList.contains('open')) {
          openDock(false);
        } else if (!isDockFullscreen) {
          setDockFullscreen(true);
        } else {
          setDockFullscreen(false);
        }
      } else if (e.key === 'Escape') {
        if (drawer.classList.contains('open')) {
          e.preventDefault();
          closeDock();
        }
      }
    });

    // 左边缘拖拽调整大小
    initResizerDrag(drawer);

    store.subscribe(() => {
      renderTaskList();
      updateBadge();
      if (activeDetailBvid) {
        renderDetailView(activeDetailBvid);
      }
    });

    renderTaskList();
    updateBadge();
  }

  function openDock(fullscreen = false) {
    const drawer = document.getElementById('bili-review-drawer');
    if (!drawer) return;
    drawer.classList.add('open');
    setDockFullscreen(fullscreen);
    renderTaskList();
  }

  function closeDock() {
    const drawer = document.getElementById('bili-review-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    setDockFullscreen(false);
  }

  function toggleDock() {
    const drawer = document.getElementById('bili-review-drawer');
    if (!drawer) return;
    if (drawer.classList.contains('open')) {
      closeDock();
    } else {
      openDock(false);
    }
  }

  function setDockFullscreen(fullscreen) {
    const drawer = document.getElementById('bili-review-drawer');
    const textEl = document.getElementById('bili-fullscreen-text');
    const iconEl = document.getElementById('bili-fullscreen-icon');
    if (!drawer) return;

    isDockFullscreen = Boolean(fullscreen);
    if (isDockFullscreen) {
      drawer.classList.add('fullscreen');
      if (textEl) textEl.textContent = '还原';
      if (iconEl) {
        iconEl.innerHTML = `
          <path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5"/>
        `;
      }
    } else {
      drawer.classList.remove('fullscreen');
      drawer.style.width = savedDockWidth || '460px';
      if (textEl) textEl.textContent = '全屏';
      if (iconEl) {
        iconEl.innerHTML = `
          <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/>
        `;
      }
    }
  }

  function toggleFullscreen() {
    setDockFullscreen(!isDockFullscreen);
  }

  function initResizerDrag(drawer) {
    const resizer = document.getElementById('bili-drawer-resizer');
    if (!resizer) return;

    let isDragging = false;
    let rafId = null;
    let pendingWidth = null;

    resizer.addEventListener('mousedown', (e) => {
      if (isDockFullscreen) return;
      e.preventDefault();
      isDragging = true;
      resizer.classList.add('dragging');
      drawer.classList.add('resizing');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const newWidth = window.innerWidth - moveEvent.clientX;
        pendingWidth = Math.min(Math.max(400, newWidth), window.innerWidth - 60);

        if (!rafId) {
          rafId = requestAnimationFrame(() => {
            if (pendingWidth !== null) {
              drawer.style.width = `${pendingWidth}px`;
              savedDockWidth = `${pendingWidth}px`;
            }
            rafId = null;
          });
        }
      };

      const onMouseUp = () => {
        if (!isDragging) return;
        isDragging = false;
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        resizer.classList.remove('dragging');
        drawer.classList.remove('resizing');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        gmStorageSet('bili_review_dock_width', savedDockWidth);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  function updateBadge() {
    const badge = document.getElementById('bili-review-badge');
    if (!badge) return;
    const completedCount = store.listTasks().filter((t) => t.status === TaskStatus.COMPLETED).length;
    badge.textContent = String(completedCount);
  }

  function switchView(viewName) {
    const listView = document.getElementById('bili-task-list-view');
    const detailView = document.getElementById('bili-summary-detail-view');
    if (viewName === 'list') {
      activeDetailBvid = null;
      listView.style.display = 'flex';
      detailView.style.display = 'none';
      renderTaskList();
    } else {
      listView.style.display = 'none';
      detailView.style.display = 'block';
    }
  }

  function renderTaskList() {
    const container = document.getElementById('bili-task-list-view');
    if (!container) return;

    const tasks = store.listTasks();
    if (tasks.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; color: #9499A0; padding: 60px 20px; font-size: 13px;">
          <div style="font-size: 36px; margin-bottom: 14px;">📑</div>
          暂无研报任务<br>
          在视频卡片右上角点击【总结】图标即可一键生成！
        </div>
      `;
      return;
    }

    container.innerHTML = tasks
      .map((t) => {
        let badgeClass = t.status;
        let badgeText = t.progress;

        if (t.status === TaskStatus.COMPLETED) {
          badgeText = '✅ 已完成';
        } else if (t.status === TaskStatus.SUMMARIZING) {
          badgeText = '🤖 AI研判中...';
        } else if (t.status === TaskStatus.EXTRACTING) {
          badgeText = '⏳ 抓取数据...';
        } else if (t.status === TaskStatus.FAILED) {
          badgeText = '❌ 失败';
        }

        return `
        <div class="bili-task-card" data-bvid="${t.bvid}">
          <button class="bili-task-del-btn" data-bvid="${t.bvid}" title="删除记录">✕</button>
          <img class="bili-task-cover" src="${t.pic || '//i0.hdslb.com/bfs/archive/placeholder.jpg'}" alt="cover" />
          <div class="bili-task-meta">
            <div class="bili-task-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</div>
            <div class="bili-task-footer">
              <span class="bili-task-author">${escapeHtml(t.author || t.bvid)}</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <button class="bili-dev-retry-btn" data-bvid="${t.bvid}" title="开发者测试：重新抓取并生成">🔄 重新调研</button>
                <span class="bili-status-badge ${badgeClass}">${badgeText}</span>
              </div>
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    // 点击卡片进入详情
    container.querySelectorAll('.bili-task-card').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bili-task-del-btn') || e.target.closest('.bili-dev-retry-btn')) return;

        const bvid = el.getAttribute('data-bvid');
        const task = store.getTask(bvid);
        if (task && task.status === TaskStatus.COMPLETED) {
          activeDetailBvid = bvid;
          switchView('detail');
          renderDetailView(bvid);
        } else if (task && task.status === TaskStatus.FAILED) {
          if (confirm(`任务失败原因: ${task.error}\n\n是否重新尝试生成？`)) {
            executeSummaryTask(bvid, task);
          }
        } else {
          showToast('⏳ 研报正在后台深度生成中，完成后即可点击查看正文');
        }
      });
    });

    // 开发者重新调研按钮（卡片列表）
    container.querySelectorAll('.bili-dev-retry-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bvid = btn.getAttribute('data-bvid');
        const task = store.getTask(bvid);
        if (task) {
          showToast(`🔄 正在重新调研《${(task.title || bvid).slice(0, 10)}...》`);
          executeSummaryTask(bvid, task);
        }
      });
    });

    // 绑定右上角就地防误触删除按钮（1:1 还原 11235 交互）
    container.querySelectorAll('.bili-task-del-btn').forEach((btn) => {
      let resetTimer = null;

      const resetBtn = () => {
        btn.dataset.confirming = 'false';
        btn.classList.remove('confirm-active');
        btn.innerHTML = '✕';
      };

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bvid = btn.getAttribute('data-bvid');

        if (btn.dataset.confirming === 'true') {
          if (resetTimer) clearTimeout(resetTimer);
          store.deleteTask(bvid);
          showToast('🗑️ 研报任务已删除');
          return;
        }

        document.querySelectorAll('.bili-task-del-btn[data-confirming="true"]').forEach((other) => {
          other.dataset.confirming = 'false';
          other.classList.remove('confirm-active');
          other.innerHTML = '✕';
        });

        btn.dataset.confirming = 'true';
        btn.classList.add('confirm-active');
        btn.innerHTML = '<span>确定删除?</span>';

        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(resetBtn, 3500);

        btn.onmouseleave = () => {
          if (resetTimer) clearTimeout(resetTimer);
          resetTimer = setTimeout(resetBtn, 1200);
        };
      });
    });
  }

  function renderDetailView(bvid) {
    const task = store.getTask(bvid);
    if (!task) return;
    const contentEl = document.getElementById('bili-detail-content');
    if (contentEl) {
      contentEl.innerHTML = renderMarkdown(task.summary);
    }
  }

  // ==========================================
  // 8. 视频卡片按钮扫描与 1:1 原生图标挂载
  // ==========================================
  const SUMMARY_ICON_SVG = `
    <svg viewBox="0 0 22 22" width="22" height="22" fill="currentColor">
      <path d="M5.5 2C4.67157 2 4 2.67157 4 3.5V18.5C4 19.3284 4.67157 20 5.5 20H16.5C17.3284 20 18 19.3284 18 18.5V7.5L12.5 2H5.5ZM12 3.5V8H16.5L12 3.5ZM6.5 11C6.5 10.5858 6.83579 10.25 7.25 10.25H14.75C15.1642 10.25 15.5 10.5858 15.5 11C15.5 11.4142 15.1642 11.75 14.75 11.75H7.25C6.83579 11.75 6.5 11.4142 6.5 11ZM6.5 14C6.5 13.5858 6.83579 13.25 7.25 13.25H14.75C15.1642 13.25 15.5 13.5858 15.5 14C15.5 14.4142 15.1642 14.75 14.75 14.75H7.25C6.83579 14.75 6.5 14.4142 6.5 14ZM7.25 16.25C6.83579 16.25 6.5 16.5858 6.5 17C6.5 17.4142 6.83579 17.75 7.25 17.75H11.75C12.1642 17.75 12.5 17.4142 12.5 17C12.5 16.5858 12.1642 16.25 11.75 16.25H7.25Z"/>
    </svg>
  `;

  function scanAndInjectVideoCards() {
    const cardSelectors = [
      '.bili-video-card__wrap',
      '.bili-video-card',
      '.feed-card',
      '.video-card',
      '.bili-video-card__image--wrap'
    ];

    const cards = document.querySelectorAll(cardSelectors.join(', '));
    cards.forEach((card) => {
      if (card.getAttribute('data-bili-review-injected')) return;

      const link = card.querySelector('a[href*="/video/BV"]');
      if (!link) return;

      const bvid = parseBvidFromUrl(link.href);
      if (!bvid) return;

      card.setAttribute('data-bili-review-injected', 'true');
      card.style.position = card.style.position || 'relative';

      const watchLater = card.querySelector('.bili-watch-later--wrap, [class*="watch-later"]');
      const coverWrap = (watchLater && watchLater.parentElement) ||
                        card.querySelector('.bili-video-card__image--wrap, .pic-box, .bili-video-card__image') ||
                        card;
      coverWrap.style.position = coverWrap.style.position || 'relative';

      const btn = document.createElement('button');
      btn.className = 'bili-review-card-btn';
      btn.innerHTML = `
        ${SUMMARY_ICON_SVG}
        <span class="bili-review-btn-text">AI 研报总结</span>
      `;
      btn.setAttribute('title', 'AI 双源情报研报总结');
      btn.setAttribute('aria-label', 'AI 总结');

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        openDock(false);

        const titleEl = card.querySelector('.bili-video-card__info--tit, .title, .bili-video-card__title');
        const authorEl = card.querySelector('.bili-video-card__info--author, .up-name, .bili-video-card__author');
        const imgEl = card.querySelector('img');

        const meta = {
          title: titleEl ? titleEl.textContent.trim() : bvid,
          author: authorEl ? authorEl.textContent.trim() : '',
          pic: imgEl ? imgEl.src : ''
        };

        const existing = store.getTask(bvid);
        if (existing && existing.status === TaskStatus.COMPLETED) {
          activeDetailBvid = bvid;
          switchView('detail');
          renderDetailView(bvid);
          return;
        }

        btn.classList.add('active');
        store.createTask(bvid, meta);
        showToast(`🚀 已将《${meta.title.slice(0, 12)}...》加入研报队列`);
        executeSummaryTask(bvid, meta);
      });

      coverWrap.appendChild(btn);
    });
  }

  // ==========================================
  // 9. 启动入口
  // ==========================================
  function main() {
    initUI();
    pullAvailableModels();
    scanAndInjectVideoCards();

    const observer = new MutationObserver(() => {
      scanAndInjectVideoCards();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('[bili-review] 2.2 油猴脚本已就绪');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }
})();
