// ==UserScript==
// @name         Bilibili 视频总结 (bili-review)
// @namespace    https://clawhub.ai/frozentearz/skills/bili-review
// @version      2.1.2
// @description  边刷B站边看AI视频总结！三源交叉检视（字幕观点 + 弹幕时序 + 楼中楼评论），右侧悬浮Dock多任务队列与 Markdown 总结阅读器。支持 Tab 键三态轮转与拖拽定宽。
// @author       Frazier
// @match        *://*.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
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
  // 1. 配置管理与动态模型拉取（支持 Anthropic 与 OpenAI 双协议）
  // ==========================================
  const DEFAULT_CONFIG = {
    apiType: 'anthropic', // 'anthropic' | 'openai'
    baseUrl: 'http://127.0.0.1:62999',
    apiKey: '',
    model: 'claude-opus-4-8',
    maxTokens: 8192
  };

  function getConfig() {
    try {
      const saved = gmStorageGet('bili_review_config');
      const parsed = saved ? (typeof saved === 'string' ? JSON.parse(saved) : saved) : {};
      const cfg = { ...DEFAULT_CONFIG, ...parsed };
      if (!cfg.model) {
        cfg.model = cfg.activeModel || cfg.targetModel || DEFAULT_CONFIG.model;
      }
      return cfg;
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  function saveConfig(cfg) {
    gmStorageSet('bili_review_config', JSON.stringify(cfg));
  }

  async function testConnectionAndFetchModels(baseUrl, apiKey, apiType = 'anthropic') {
    const cleanUrl = (baseUrl || '').replace(/\/+$/, '');
    if (!cleanUrl) throw new Error('API 地址不能为空');

    const headers = {};
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
      headers['x-api-key'] = apiKey;
    }
    headers['anthropic-version'] = '2023-06-01';

    const endpoint = cleanUrl.endsWith('/v1') ? `${cleanUrl}/models` : `${cleanUrl}/v1/models`;

    const resRaw = await gmFetch(endpoint, {
      method: 'GET',
      headers,
      timeout: 8000
    });

    let resJson;
    try {
      resJson = JSON.parse(resRaw);
    } catch (e) {
      throw new Error(`返回数据不是合法的 JSON: ${resRaw.slice(0, 100)}`);
    }

    if (resJson.error) {
      throw new Error(resJson.error.message || JSON.stringify(resJson.error));
    }

    let models = [];
    if (Array.isArray(resJson.data)) {
      models = resJson.data.map((m) => m.id || m.name).filter(Boolean);
    } else if (Array.isArray(resJson.models)) {
      models = resJson.models.map((m) => m.id || m.name).filter(Boolean);
    }

    return {
      ok: true,
      models,
      count: models.length
    };
  }

  // ==========================================
  // 2. 状态机与持久化存储 (TaskStore)
  // ==========================================
  const TaskStatus = {
    PENDING: 'pending',
    EXTRACTING: 'extracting',
    SUMMARIZING: 'summarizing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted'
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
        duration: 0,
        startTime: Date.now(),
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
      return Array.from(this.tasks.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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
          const entryList = Array.isArray(entries) ? entries : (typeof entries === 'object' && entries !== null ? Object.entries(entries) : []);
          entryList.forEach(([_, t]) => {
            if (t && (t.status === TaskStatus.EXTRACTING || t.status === TaskStatus.SUMMARIZING)) {
              t.status = TaskStatus.INTERRUPTED;
              t.progress = '⚠️ 已中断';
            }
          });
          this.tasks = new Map(entryList);
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

  function formatSubtitleList(body) {
    if (!Array.isArray(body) || body.length === 0) return '';
    const cleanedItems = [];
    let lastText = '';

    for (const item of body) {
      let content = String(item?.content || '').trim();
      if (!content) continue;

      // 1. 相邻完全相同内容过滤
      if (content === lastText) continue;

      // 2. 滑动窗口前缀包含消除（处理识别词逐步拼接）
      if (lastText && content.startsWith(lastText)) {
        if (cleanedItems.length > 0) {
          cleanedItems[cleanedItems.length - 1].content = content;
          cleanedItems[cleanedItems.length - 1].to = item.to || cleanedItems[cleanedItems.length - 1].to;
          lastText = content;
          continue;
        }
      } else if (lastText && lastText.startsWith(content)) {
        continue;
      }

      cleanedItems.push({
        from: Number(item.from) || 0,
        to: Number(item.to) || 0,
        content
      });
      lastText = content;
    }

    // 3. 自然停顿与整句合并（按标点、语义适中长度 >= 50 或停顿 > 2.5s 聚合为自然整句）
    const sentences = [];
    let currentSentence = '';
    let sentenceStartTime = null;

    for (let i = 0; i < cleanedItems.length; i++) {
      const item = cleanedItems[i];
      if (sentenceStartTime === null) {
        sentenceStartTime = item.from;
      }

      if (currentSentence) {
        currentSentence += (/[a-zA-Z0-9]$/.test(currentSentence) ? ' ' : '') + item.content;
      } else {
        currentSentence = item.content;
      }

      const nextItem = cleanedItems[i + 1];
      const isTimeGap = nextItem && (nextItem.from - item.to > 2.5);
      const isPunctuation = /[。！？!?；;\n]$/.test(item.content);
      const isLengthThreshold = currentSentence.length >= 50;

      if (!nextItem || isTimeGap || isPunctuation || isLengthThreshold) {
        sentences.push(`${formatSecondsToTime(sentenceStartTime)} ${currentSentence.trim()}`);
        currentSentence = '';
        sentenceStartTime = null;
      }
    }

    return sentences.join('\n');
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
    const isBiliApi = url.includes('bilibili.com');
    const isCdn = url.includes('hdslb.com') || url.includes('bilivideo.com');
    const isBiliDomain = isBiliApi || isCdn;

    // 1. 若为 B 站同源/子域名或 CDN，优先使用浏览器原生 fetch
    if (isBiliDomain) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 8000));

        // 自动过滤受保护请求头（Referer / User-Agent 等），避免浏览器 fetch 抛出 TypeError
        const safeHeaders = { ...(options.headers || {}) };
        delete safeHeaders['Referer'];
        delete safeHeaders['referer'];
        delete safeHeaders['User-Agent'];
        delete safeHeaders['user-agent'];
        delete safeHeaders['Host'];
        delete safeHeaders['host'];
        delete safeHeaders['Origin'];
        delete safeHeaders['origin'];

        const fetchOpts = {
          method: options.method || 'GET',
          headers: safeHeaders,
          body: options.body || null,
          signal: controller.signal,
          // 关键修复：CDN 静态资源（如 aisubtitle.hdslb.com）绝不能携带 include，否则与 CDN 返回的 Access-Control-Allow-Origin: * 发生浏览器硬性 CORS 冲突
          credentials: isCdn ? 'omit' : 'include'
        };
        const res = await fetch(url, fetchOpts);
        clearTimeout(timer);
        if (res.status >= 200 && res.status < 300) {
          return await res.text();
        }
      } catch (fetchErr) {
        // 若原生 fetch 失败，自动降级至 GM_xmlhttpRequest
      }
    }

    // 2. 跨域 AI 接口 或 B 站跨源降级，走 GM_xmlhttpRequest
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

        const gmHeaders = { ...(options.headers || {}) };
        if (isBiliDomain && !gmHeaders['Referer']) {
          gmHeaders['Referer'] = 'https://www.bilibili.com';
        }

        GM_xmlhttpRequest({
          method: options.method || 'GET',
          url,
          headers: gmHeaders,
          data: options.body || null,
          timeout: timeoutMs,
          withCredentials: isBiliApi && !isCdn,
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

  // ==========================================
  // WBI 签名与纯 JS MD5 引擎 (用于解除官方 AI 字幕限制)
  // ==========================================
  function md5(string) {
    function rotateLeft(lValue, iShiftBits) {
      return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
    }
    function addUnsigned(lX, lY) {
      const lX8 = lX & 0x80000000;
      const lY8 = lY & 0x80000000;
      const lX4 = lX & 0x40000000;
      const lY4 = lY & 0x40000000;
      const lResult = (lX & 0x3fffffff) + (lY & 0x3fffffff);
      if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
      if (lX4 | lY4) {
        if (lResult & 0x40000000) return lResult ^ 0xc0000000 ^ lX8 ^ lY8;
        return lResult ^ 0x40000000 ^ lX8 ^ lY8;
      }
      return lResult ^ lX8 ^ lY8;
    }
    function F(x, y, z) { return (x & y) | (~x & z); }
    function G(x, y, z) { return (x & z) | (y & ~z); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | ~z); }
    function FF(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function GG(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function HH(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function II(a, b, c, d, x, s, ac) {
      a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
      return addUnsigned(rotateLeft(a, s), b);
    }
    function convertToWordArray(string) {
      let lWordCount;
      const lMessageLength = string.length;
      const lNumberOfWords_temp1 = lMessageLength + 8;
      const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
      const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
      const lWordArray = Array(lNumberOfWords - 1);
      let lBytePosition = 0;
      let lByteCount = 0;
      while (lByteCount < lMessageLength) {
        lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] = lWordArray[lWordCount] | (string.charCodeAt(lByteCount) << lBytePosition);
        lByteCount++;
      }
      lWordCount = (lByteCount - (lByteCount % 4)) / 4;
      lBytePosition = (lByteCount % 4) * 8;
      lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
      lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
      lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
      return lWordArray;
    }
    function wordToHex(lValue) {
      let WordToHexValue = '', WordToHexValue_temp = '', lByte, lCount;
      for (lCount = 0; lCount <= 3; lCount++) {
        lByte = (lValue >>> (lCount * 8)) & 255;
        WordToHexValue_temp = '0' + lByte.toString(16);
        WordToHexValue = WordToHexValue + WordToHexValue_temp.substr(WordToHexValue_temp.length - 2, 2);
      }
      return WordToHexValue;
    }
    const x = convertToWordArray(unescape(encodeURIComponent(string)));
    let k, AA, BB, CC, DD, a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const S11 = 7, S12 = 12, S13 = 17, S14 = 22;
    const S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23;
    const S41 = 6, S42 = 10, S43 = 15, S44 = 21;
    for (k = 0; k < x.length; k += 16) {
      AA = a; BB = b; CC = c; DD = d;
      a = FF(a, b, c, d, x[k + 0], S11, 0xd76aa478); d = FF(d, a, b, c, x[k + 1], S12, 0xe8c7b756);
      c = FF(c, d, a, b, x[k + 2], S13, 0x242070db); b = FF(b, c, d, a, x[k + 3], S14, 0xc1bdceee);
      a = FF(a, b, c, d, x[k + 4], S11, 0xf57c0faf); d = FF(d, a, b, c, x[k + 5], S12, 0x4787c62a);
      c = FF(c, d, a, b, x[k + 6], S13, 0xa8304613); b = FF(b, c, d, a, x[k + 7], S14, 0xfd469501);
      a = FF(a, b, c, d, x[k + 8], S11, 0x698098d8); d = FF(d, a, b, c, x[k + 9], S12, 0x8b44f7af);
      c = FF(c, d, a, b, x[k + 10], S13, 0xffff5bb1); b = FF(b, c, d, a, x[k + 11], S14, 0x895cd7be);
      a = FF(a, b, c, d, x[k + 12], S11, 0x6b901122); d = FF(d, a, b, c, x[k + 13], S12, 0xfd987193);
      c = FF(c, d, a, b, x[k + 14], S13, 0xa679438e); b = FF(b, c, d, a, x[k + 15], S14, 0x49b40821);
      a = GG(a, b, c, d, x[k + 1], S21, 0xf61e2562); d = GG(d, a, b, c, x[k + 6], S22, 0xc040b340);
      c = GG(c, d, a, b, x[k + 11], S23, 0x265e5a51); b = GG(b, c, d, a, x[k + 0], S24, 0xe9b6c7aa);
      a = GG(a, b, c, d, x[k + 5], S21, 0xd62f105d); d = GG(d, a, b, c, x[k + 10], S22, 0x2441453);
      c = GG(c, d, a, b, x[k + 15], S23, 0xd8a1e681); b = GG(b, c, d, a, x[k + 4], S24, 0xe7d3fbc8);
      a = GG(a, b, c, d, x[k + 9], S21, 0x21e1cde6); d = GG(d, a, b, c, x[k + 14], S22, 0xc33707d6);
      c = GG(c, d, a, b, x[k + 3], S23, 0xf4d50d87); b = GG(b, c, d, a, x[k + 8], S24, 0x455a14ed);
      a = GG(a, b, c, d, x[k + 13], S21, 0xa9e3e905); d = GG(d, a, b, c, x[k + 2], S22, 0xfcefa3f8);
      c = GG(c, d, a, b, x[k + 7], S23, 0x676f02d9); b = GG(b, c, d, a, x[k + 12], S24, 0x8d2a4c8a);
      a = HH(a, b, c, d, x[k + 5], S31, 0xfffa3942); d = HH(d, a, b, c, x[k + 8], S32, 0x8771f681);
      c = HH(c, d, a, b, x[k + 11], S33, 0x6d9d6122); b = HH(b, c, d, a, x[k + 14], S34, 0xfde5380c);
      a = HH(a, b, c, d, x[k + 1], S31, 0xa4beea44); d = HH(d, a, b, c, x[k + 4], S32, 0x4bdecfa9);
      c = HH(c, d, a, b, x[k + 7], S33, 0xf6bb4b60); b = HH(b, c, d, a, x[k + 10], S34, 0xbebfbc70);
      a = HH(a, b, c, d, x[k + 13], S31, 0x289b7ec6); d = HH(d, a, b, c, x[k + 0], S32, 0xeaa127fa);
      c = HH(c, d, a, b, x[k + 3], S33, 0xd4ef3085); b = HH(b, c, d, a, x[k + 6], S34, 0x4881d05);
      a = HH(a, b, c, d, x[k + 9], S31, 0xd9d4d039); d = HH(d, a, b, c, x[k + 12], S32, 0xe6db99e5);
      c = HH(c, d, a, b, x[k + 15], S33, 0x1fa27cf8); b = HH(b, c, d, a, x[k + 2], S34, 0xc4ac5665);
      a = II(a, b, c, d, x[k + 0], S41, 0xf4292244); d = II(d, a, b, c, x[k + 7], S42, 0x432aff97);
      c = II(c, d, a, b, x[k + 14], S43, 0xab9423a7); b = II(b, c, d, a, x[k + 5], S44, 0xfc93a039);
      a = II(a, b, c, d, x[k + 12], S41, 0x655b59c3); d = II(d, a, b, c, x[k + 3], S42, 0x8f0ccc92);
      c = II(c, d, a, b, x[k + 10], S43, 0xffeff47d); b = II(b, c, d, a, x[k + 1], S44, 0x85845dd1);
      a = II(a, b, c, d, x[k + 8], S41, 0x6fa87e4f); d = II(d, a, b, c, x[k + 15], S42, 0xfe2ce6e0);
      c = II(c, d, a, b, x[k + 6], S43, 0xa3014314); b = II(b, c, d, a, x[k + 13], S44, 0x4e0811a1);
      a = II(a, b, c, d, x[k + 4], S41, 0xf7537e82); d = II(d, a, b, c, x[k + 11], S42, 0xbd3af235);
      c = II(c, d, a, b, x[k + 2], S43, 0x2ad7d2bb); b = II(b, c, d, a, x[k + 9], S44, 0xeb86d391);
      a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
    }
    return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
  }

  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52
  ];

  let cachedWbiKeys = null;
  let cachedWbiTime = 0;

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : (typeof window !== 'undefined' ? window : globalThis);
  }

  async function getWbiKeys() {
    const now = Date.now();
    if (cachedWbiKeys && now - cachedWbiTime < 1000 * 60 * 10) {
      return cachedWbiKeys;
    }
    // 1. 若当前页面已挂载 wbi_img，穿透沙箱零延迟直接读取
    try {
      const pageWin = getPageWindow();
      const pageWbi = pageWin.__INITIAL_STATE__?.wbi_img ||
                      pageWin.__pinia?.wbi_img ||
                      pageWin.__INITIAL_STATE__?.wbiImg;
      if (pageWbi?.img_url && pageWbi?.sub_url) {
        const imgKey = pageWbi.img_url.split('/').pop().split('.')[0];
        const subKey = pageWbi.sub_url.split('/').pop().split('.')[0];
        if (imgKey && subKey) {
          cachedWbiKeys = { imgKey, subKey };
          cachedWbiTime = now;
          return cachedWbiKeys;
        }
      }
    } catch (_) {}

    // 2. 通过 nav 接口动态获取
    try {
      const navRaw = await gmFetch('https://api.bilibili.com/x/web-interface/nav', { timeout: 6000 });
      const navJson = JSON.parse(navRaw);
      const wbiImg = navJson.data?.wbi_img;
      if (wbiImg?.img_url && wbiImg?.sub_url) {
        const imgKey = wbiImg.img_url.split('/').pop().split('.')[0];
        const subKey = wbiImg.sub_url.split('/').pop().split('.')[0];
        cachedWbiKeys = { imgKey, subKey };
        cachedWbiTime = now;
        return cachedWbiKeys;
      }
    } catch (e) {
      console.warn('[bili-review] 获取 WBI 密钥失败:', e);
    }
    return { imgKey: '7cd084941338484aae1ad9425b84077c', subKey: '4932caff0ff746eab6f01bf08b70ac45' };
  }

  function signWbiParams(params, imgKey, subKey) {
    const rawKey = imgKey + subKey;
    const mixinKey = MIXIN_KEY_ENC_TAB.map((n) => rawKey[n]).join('').slice(0, 32);
    const currTime = Math.round(Date.now() / 1000);
    const p = { ...params, wts: currTime };
    const sortedKeys = Object.keys(p).sort();
    const queryParts = [];
    for (const k of sortedKeys) {
      const v = String(p[k]).replace(/[!'()*]/g, '');
      queryParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    }
    const queryString = queryParts.join('&');
    const wbiSign = md5(queryString + mixinKey);
    return `${queryString}&w_rid=${wbiSign}`;
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

    // 2. 严格按 aid/cid 独立抓取字幕（支持原生极速直读、WBI v2 官方 AI 字幕与多重容灾降级）
    let subtitleText = '';
    try {
      let subList = [];

      // 2.0 当前播放视频极速通道（穿透沙箱直接提取）
      try {
        const pageWin = getPageWindow();
        const state = pageWin.__INITIAL_STATE__;
        const pinia = pageWin.__pinia;
        const curBvid = state?.videoData?.bvid || state?.bvid || pinia?.videoData?.bvid || '';
        const curAid = state?.videoData?.aid || state?.aid || pinia?.videoData?.aid || '';
        const path = (pageWin.location?.pathname || (typeof window !== 'undefined' ? window.location?.pathname : '')) || '';

        const isCurrentPage = (curBvid && curBvid === bvid) ||
                              (curAid && String(curAid) === String(aid)) ||
                              path.includes(bvid);

        if (isCurrentPage) {
          const inPageSubs = state?.videoData?.subtitle?.list ||
                             pinia?.videoData?.subtitle?.list ||
                             state?.subtitle?.list ||
                             (pageWin.player?.getSubtitle ? pageWin.player.getSubtitle() : null) || [];
          if (Array.isArray(inPageSubs) && inPageSubs.length > 0) {
            subList = inPageSubs.filter((s) => s && (s.subtitle_url || s.url));
            console.log(`[bili-review] [1/4] ✅ 成功从宿主页面直读提取到 ${subList.length} 条字幕:`, subList);
          }
        }
      } catch (inPageErr) {
        console.warn('[bili-review] 宿主页面字幕直读异常:', inPageErr);
      }

      // 2.1 WBI v2 动态验签直连（主通路 1：aid + cid + bvid）
      if (subList.length === 0) {
        try {
          const { imgKey, subKey } = await getWbiKeys();
          const signedQuery = signWbiParams({ aid, cid, bvid }, imgKey, subKey);
          const playerRaw = await gmFetch(`https://api.bilibili.com/x/player/wbi/v2?${signedQuery}`, {
            timeout: 6000,
            headers: {
              'Referer': `https://www.bilibili.com/video/${bvid}`
            }
          });
          const playerJson = JSON.parse(playerRaw);
          subList = playerJson.data?.subtitle?.subtitles || [];
          if (subList.length > 0) {
            console.log(`[bili-review] [1/4] ✅ WBI v2 接口提取到 ${subList.length} 条字幕`);
          } else if (playerJson.data?.need_login_subtitle) {
            console.warn('[bili-review] ⚠️ WBI 接口提示 need_login_subtitle=true (需登录态凭据)');
          }
        } catch (wbiErr) {
          console.warn('[bili-review] WBI 接口异常，尝试备用签名:', wbiErr.message);
        }
      }

      // 2.2 WBI v2 备用签名（主通路 2：aid + cid）
      if (subList.length === 0) {
        try {
          const { imgKey, subKey } = await getWbiKeys();
          const signedQuery = signWbiParams({ aid, cid }, imgKey, subKey);
          const playerRaw = await gmFetch(`https://api.bilibili.com/x/player/wbi/v2?${signedQuery}`, {
            timeout: 5000,
            headers: {
              'Referer': `https://www.bilibili.com/video/${bvid}`
            }
          });
          const playerJson = JSON.parse(playerRaw);
          subList = playerJson.data?.subtitle?.subtitles || [];
        } catch (_) {}
      }

      // 2.3 降级兼容：尝试旧版 player/v2
      if (subList.length === 0) {
        try {
          const legacyRaw = await gmFetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, { timeout: 4000 });
          const legacyJson = JSON.parse(legacyRaw);
          subList = legacyJson.data?.subtitle?.subtitles || [];
        } catch (legacyErr) {
          console.warn('[bili-review] 尝试旧版 player/v2 接口未获取字幕:', legacyErr.message);
        }
      }

      if (subList.length > 0) {
        // 智能匹配字幕（优先 ai-zh / zh-CN / zh-Hans / zh-Hant 等中文，或任意可用字幕）
        const targetSub = subList.find((s) => s.lan === 'ai-zh' || s.lan === 'zh-CN' || s.lan === 'zh-Hans') ||
                          subList.find((s) => s.lan && s.lan.startsWith('zh')) ||
                          subList.find((s) => s.subtitle_url || s.url) ||
                          subList[0];

        let subUrl = targetSub.subtitle_url || targetSub.url;
        if (subUrl) {
          if (subUrl.startsWith('//')) subUrl = 'https:' + subUrl;
          console.log('[bili-review] [2/4] 正在下载字幕文件:', subUrl);
          const subContentRaw = await gmFetch(subUrl, { timeout: 8000 });
          const subData = JSON.parse(subContentRaw);
          if (Array.isArray(subData.body)) {
            subtitleText = formatSubtitleList(subData.body);
            console.log(`[bili-review] [3/4] ✅ 字幕下载并清洗成功: ${subtitleText.length} 字符`);
          }
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
  // 4. Prompt 组装与官方 bili-review 规范
  // ==========================================
  function getSystemPrompt() {
    return `你是 B 站视频总结助手（bili-review 总结引擎）。
本任务以 bili-review 自身独立的 Prompt 为最高准则，禁止使用 AGENTS.md 的内容作为提示词。
你的核心任务是通过整合【视频字幕】、【高能弹幕时序】与【评论区楼中楼讨论】，进行交叉事实检视，输出结构清晰、无废话的视频总结。

【4 大视频场景总结分析框架】：
根据视频的核心诉求，自动选用对应结构组织详细总结正文：
1. 测评 / 避坑 / 选型 ➔ 【红黑榜对比法】
   - 🟢 红榜（宣称亮点）：UP 主宣传卖点与纸面参数
   - 🔴 黑榜（扒出槽点）：弹幕/评论扒出的缺陷、发热、暗病、隐藏成本与翻车实测
   - ⚖️ 选型建议与民间平替：适合人群、避坑提醒、评论区推荐的更优替代方案
2. 教程 / 实操 / 配置 ➔ 【步骤清单（做减法）】
   - 🛠️ 准备工作与依赖：必备软件、环境与配置文件
   - 📋 核心操作步骤：直接给出代码/指令/配置（剔除口水话）
   - ✂️ 做减法与避坑：标明哪些步骤是弯路可直接跳过，附高赞优化补丁
3. 观点 / 商业 / 热点 ➔ 【前因后果与内幕】
   - 📖 发生了啥：背景与核心矛盾
   - 🧠 UP 主核心主张：主要论点与趋势预测
   - 🔍 评论区内幕爆料：各方站队与业内补充（附点赞数）
   - 💡 底层真相：对普通人的实际影响
4. 科普 / 原理 / 架构 ➔ 【通俗打比方与机制拆解】
   - 💡 通俗大白话比方：用生活化比喻解释核心概念
   - ⚙️ 底层运作机制：核心运转链路拆解
   - 📌 弹幕纠错与细节补充：指出讲得不够严谨之处

【质量与排版规则】：
1. 速读卡和详细总结尽量互不重复。
2. 每段首句出结论，关键数据、核心参数、代码指令必须加粗。
3. 涉及参数对比、版本差异、优缺点比对时，优先采用 Markdown 小表格。
4. 严禁 AI 套话腔调（严禁出现“综上所述”、“值得注意的是”、“不可否认”、“赋能”、“不仅...而且...”等词）。
5. 独立客观：直接输出视频总结内容，严禁输出任何问候语、对话开场白或人称称呼。
6. 会话与数据隔离：本任务仅针对当前输入的单一视频数据进行独立事实总结，严禁与历史会话中讨论过的其他视频数据混淆与关联。`;
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

    if (!subtitleText || !subtitleText.trim()) {
      throw new Error('该视频Bilibili官方暂未生成 AI 字幕，不支持总结');
    }
    const contentSection = subtitleText.trim();

    const safeComments = finalComments && finalComments.trim() ? finalComments.trim() : '暂无精选评论';

    const bvidTag = bvid ? ` (${bvid})` : '';

    const danmakuSection = danmakuSecText && danmakuSecText.trim()
      ? `\n=== 【弹幕时序热点与即时反馈${bvidTag}】 ===\n${danmakuSecText.trim()}\n`
      : '';

    return `请根据以下 B 站视频三源数据，严格按照 bili-review 输出契约规范生成结构化视频总结：

=== 视频元数据 ===
- 视频标题: ${title}
- UP主: ${author}
- 发布时间: ${pubdate}
- BV号: ${bvid}
- 视频链接: https://www.bilibili.com/video/${bvid}

=== 【视频字幕/文稿内容${bvidTag}】 ===
${contentSection}
${danmakuSection}
=== 【评论区与楼中楼讨论${bvidTag}】 ===
${safeComments}

------------------------
【输出格式要求】：必须严格遵循以下标准 Markdown 结构交付：

# 《${title}》视频总结

> 👤 **UP主**：${author} ｜ 📅 **发布时间**：${pubdate} ｜ 🔗 **视频地址**：https://www.bilibili.com/video/${bvid}

---

### ⚡ 速读卡
- 🚦 **判定结论**：【⚠️ 避坑 / ✅ 必看 / ⏩ 建议跳过 / 🔍 存疑】（一句话定性）
- 📌 **一句话主张**：（30字内）UP 主核心在推什么或讲什么。
- 🔍 **弹幕/评论真相**：（50字内）弹幕高能吐槽与评论区翻车/实测点（附带 [MM:SS] 或点赞数）。
- 🎯 **行动建议**：（20字内）直接划走 / 抄哪段代码 / 哪个时间点起看。

---

## 📌 详细总结

<!-- 根据视频类型，自动选择以下 4 种结构之一展开，不要重复上面的结论 -->

<!-- ==================== 选项 1：测评 / 避坑类 ==================== -->
### 1. 🟢 UP 主吹的卖点（红榜）
- 核心卖点与宣称优势（数据加粗，单段 ≤ 3 行）。
### 2. 🔴 弹幕与评论扒出的槽点（黑榜）
- 弹幕 [MM:SS] 密集吐槽点。
- 评论区（附点赞数）实测翻车、暗病、发热或隐藏成本。
### 3. ⚖️ 选型建议与民间平替
- 适合谁 / 千万别买谁 / 评论区推荐的更优替代方案。

<!-- ==================== 选项 2：教程 / 实操类 ==================== -->
### 1. 🛠️ 准备工作与环境依赖
- 必备软件、环境与配置文件（直接给版本与链接）。
### 2. 📋 核心操作步骤（直接抄作业）
- [MM:SS] 步骤 1：直接给代码/命令/配置（剔除口水话）。
- [MM:SS] 步骤 2：...
### 3. ✂️ 做减法与避坑
- 可跳过的冗余步骤：标明视频中哪些步骤是弯路，直接跳过。
- 评论区优化补丁：高赞网友提供的一键脚本或避坑配置。

<!-- ==================== 选项 3：观点 / 商业类 ==================== -->
### 1. 📖 发生了啥（背景与核心矛盾）
### 2. 🧠 UP 主的核心观点与预测
### 3. 🔍 评论区内幕爆料与各方站队（带点赞数）
### 4. 💡 底层真相（对普通人有什么实际影响）

<!-- ==================== 选项 4：科普 / 原理类 ==================== -->
### 1. 💡 通俗大白话比方（5 秒听懂核心概念）
### 2. ⚙️ 底层运作机制与核心链路拆解
### 3. 📌 弹幕纠错与细节补充（指出不严谨处）
`;
  }

  async function callAiApi(prompt, bvid = '') {
    const cfg = getConfig();
    const cleanUrl = (cfg.baseUrl || 'http://127.0.0.1:62999').replace(/\/+$/, '');
    const model = cfg.model || cfg.activeModel || cfg.targetModel || 'claude-opus-4-8';
    const maxTokens = Number(cfg.maxTokens) || 8192;
    const isAnthropic = cfg.apiType === 'anthropic' || (!cfg.apiType && (cleanUrl.includes('anthropic.com') || cleanUrl.includes('62999')));

    let endpoint = '';
    let headers = {};
    let body = {};

    if (isAnthropic) {
      endpoint = cleanUrl.endsWith('/v1') ? `${cleanUrl}/messages` : `${cleanUrl}/v1/messages`;
      headers = {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'content-type': 'application/json',
        'x-app': 'cli',
        'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)',
        'x-session-id': `${bvid || 'task'}_${Date.now()}`,
        'x-conversation-id': `${bvid || 'task'}_${Date.now()}`
      };
      body = {
        model,
        max_tokens: maxTokens,
        system: getSystemPrompt(),
        stream: false,
        messages: [{ role: 'user', content: prompt }]
      };
    } else {
      // OpenAI 兼容格式 (如 DeepSeek, GPT-4o, Ollama, OneAPI)
      endpoint = cleanUrl.endsWith('/v1') ? `${cleanUrl}/chat/completions` : `${cleanUrl}/v1/chat/completions`;
      headers = {
        'Authorization': `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json'
      };
      body = {
        model,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: prompt }
        ]
      };
    }

    const resText = await gmFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeout: 90000
    });

    let json;
    try {
      json = JSON.parse(resText);
    } catch (e) {
      throw new Error(`模型响应解析失败 (非 JSON): ${resText.slice(0, 150)}`);
    }

    if (json.error) {
      throw new Error(json.error.message || (typeof json.error === 'string' ? json.error : JSON.stringify(json.error)));
    }

    // 智能提取内容 (兼容 Anthropic 与 OpenAI 结构)
    if (Array.isArray(json.content) && json.content.length > 0) {
      return json.content.map((c) => c.text || '').join('');
    }
    if (Array.isArray(json.choices) && json.choices.length > 0) {
      return json.choices[0].message?.content || json.choices[0].text || '';
    }
    if (typeof json.text === 'string') {
      return json.text;
    }

    return resText;
  }

  async function executeSummaryTask(bvid, meta) {
    const taskStartTime = Date.now();
    store.updateTask(bvid, {
      status: TaskStatus.EXTRACTING,
      progress: '抓取数据中...',
      startTime: taskStartTime,
      error: ''
    });

    try {
      const { videoInfo, subtitleText, danmakuSummary, commentsText } = await fetchBiliVideoData(bvid);
      store.updateTask(bvid, {
        title: videoInfo.title || meta.title || bvid,
        author: videoInfo.author || meta.author || '',
        pic: videoInfo.pic || meta.pic || '',
        pubdate: videoInfo.pubdate || meta.pubdate || '',
        status: TaskStatus.SUMMARIZING,
        progress: 'AI 总结中...',
        startTime: Date.now()
      });

      const prompt = buildReviewPrompt(videoInfo, subtitleText, danmakuSummary, commentsText);
      const summaryResult = await callAiApi(prompt, bvid);
      const duration = Math.max(1, Math.round((Date.now() - taskStartTime) / 1000));

      store.updateTask(bvid, {
        status: TaskStatus.COMPLETED,
        progress: '待查看',
        duration,
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
      background: linear-gradient(135deg, rgba(0, 174, 236, 0.95), rgba(0, 142, 204, 0.98));
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #fff;
      padding: 8px 12px 8px 14px;
      border-radius: 20px 0 0 20px;
      cursor: grab;
      z-index: 999990;
      box-shadow: -2px 4px 20px rgba(0, 174, 236, 0.35), 0 2px 6px rgba(0, 0, 0, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.28);
      border-right: none;
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: top 0.15s ease-out, box-shadow 0.25s cubic-bezier(0.16, 1, 0.3, 1), padding 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      user-select: none;
      touch-action: none;
    }
    #bili-review-float-btn.dragging {
      cursor: grabbing !important;
      transition: none !important;
      opacity: 0.94;
      box-shadow: -4px 8px 28px rgba(0, 174, 236, 0.65);
      transform: translateY(0) scale(1.02);
    }
    #bili-review-float-btn:hover {
      padding-left: 18px;
      box-shadow: -4px 6px 24px rgba(0, 174, 236, 0.5), 0 2px 8px rgba(0, 0, 0, 0.12);
      transform: translateY(-50%) translateX(-2px);
    }
    .bili-float-kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro", "Segoe UI", Roboto, sans-serif;
      background: rgba(255, 255, 255, 0.22);
      color: #fff;
      padding: 1px 5px;
      border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.4);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
      letter-spacing: 0.3px;
      line-height: 1.2;
    }
    #bili-review-badge {
      background: #00D084;
      color: #fff;
      font-size: 11px;
      border-radius: 10px;
      padding: 1px 6px;
      font-weight: 700;
      display: inline-block;
      box-shadow: 0 2px 6px rgba(0, 208, 132, 0.4);
      line-height: 1.3;
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
      overflow: hidden;
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
    #bili-review-drawer.fullscreen .bili-drawer-header {
      width: 100%;
      max-width: 1100px;
      margin: 0 auto;
      padding: 12px clamp(24px, 5vw, 60px);
      box-sizing: border-box;
    }
    #bili-review-drawer.fullscreen #bili-task-list-view {
      width: 100%;
      flex: 1;
      overflow-y: auto;
      max-width: 1100px;
      margin: 0 auto;
      padding: 28px clamp(24px, 5vw, 60px);
      box-sizing: border-box;
    }
    #bili-review-drawer.fullscreen #bili-summary-detail-view {
      width: 100%;
      flex: 1;
      overflow-y: auto;
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 clamp(24px, 5vw, 60px) 40px clamp(24px, 5vw, 60px);
      box-sizing: border-box;
    }
    #bili-review-drawer.fullscreen .bili-detail-toolbar {
      margin: 0 calc(-1 * clamp(24px, 5vw, 60px)) 20px calc(-1 * clamp(24px, 5vw, 60px));
      padding: 14px clamp(24px, 5vw, 60px);
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
      padding: 9px 12px;
      border-bottom: 1px solid #E3E5E7;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      background: #F6F7F8;
      flex-wrap: nowrap;
      min-width: 0;
      box-sizing: border-box;
    }
    .bili-drawer-title {
      font-size: 13.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 5px;
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
      gap: 4px;
      flex-shrink: 0;
      white-space: nowrap;
    }

    /* 1:1 还原带快捷键徽章的按钮样式 */
    .bili-header-pill-btn {
      background: #18191C;
      color: #E2E8F0;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      padding: 3px 6px;
      font-size: 11.5px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 3px;
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
      border-radius: 3px;
      padding: 1px 3px;
      font-size: 10px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      color: #10B981;
      line-height: 1.2;
      display: inline-block;
      white-space: nowrap;
    }

    /* 播放页一键总结本视频专属高亮按钮 */
    .bili-current-video-btn {
      background: linear-gradient(135deg, #00AEEC, #0084B6) !important;
      color: #FFFFFF !important;
      border: 1px solid #00AEEC !important;
      font-weight: 600 !important;
      animation: bili-btn-glow 2.5s infinite ease-in-out;
    }
    .bili-current-video-btn:hover {
      background: linear-gradient(135deg, #009CD8, #00709E) !important;
      box-shadow: 0 2px 10px rgba(0, 174, 236, 0.5) !important;
      transform: translateY(-1px);
    }
    .bili-current-video-btn.completed-state {
      background: linear-gradient(135deg, #1A7F37, #15622C) !important;
      border-color: #1A7F37 !important;
      animation: none !important;
    }
    @keyframes bili-btn-glow {
      0%, 100% { box-shadow: 0 0 0 rgba(0, 174, 236, 0); }
      50% { box-shadow: 0 0 10px rgba(0, 174, 236, 0.55); }
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
      text-decoration: none;
      cursor: pointer;
      transition: color 0.15s ease;
    }
    .bili-task-title:hover {
      color: #00AEEC !important;
      text-decoration: underline;
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
    .bili-task-subfooter {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      margin-top: 5px;
      padding-top: 4px;
      border-top: 1px dashed #F1F2F3;
    }
    .bili-task-time {
      font-size: 10px;
      color: #9499A0;
      white-space: nowrap;
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
    .bili-status-badge.interrupted {
      background: #FEF3C7;
      color: #D97706;
      border: 1px solid #FCD34D;
    }

    /* 开发者测试用：重新总结按钮 */
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

    /* API 设置弹窗 Modal */
    .bili-modal-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 16px;
      box-sizing: border-box;
      animation: bili-fade-in 0.15s ease-out;
    }
    .bili-modal-card {
      background: #FFFFFF;
      border: 1px solid #E3E5E7;
      border-radius: 12px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .bili-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #F1F2F3;
    }
    .bili-modal-title {
      font-size: 14px;
      font-weight: 700;
      color: #18191C;
    }
    .bili-modal-close {
      background: none;
      border: none;
      font-size: 16px;
      color: #9499A0;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      border-radius: 4px;
    }
    .bili-modal-close:hover {
      color: #18191C;
      background: #F1F2F3;
    }
    .bili-modal-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 70vh;
      overflow-y: auto;
    }
    .bili-form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .bili-form-label {
      font-size: 12px;
      font-weight: 600;
      color: #61666D;
    }
    .bili-radio-group {
      display: flex;
      gap: 12px;
      font-size: 12px;
      color: #18191C;
      flex-wrap: wrap;
    }
    .bili-radio-item {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .bili-form-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid #DCDFE6;
      border-radius: 6px;
      font-size: 12px;
      color: #18191C;
      background: #FAFAFA;
      outline: none;
      transition: all 0.2s;
    }
    .bili-form-input:focus {
      border-color: #00AEEC;
      background: #FFFFFF;
      box-shadow: 0 0 0 2px rgba(0, 174, 236, 0.15);
    }
    .bili-input-with-btn {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .bili-input-icon-btn {
      background: #F1F2F3;
      border: 1px solid #E3E5E7;
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .bili-input-icon-btn:hover {
      background: #E3E5E7;
    }
    .bili-secondary-btn {
      background: #F1F2F3;
      border: 1px solid #E3E5E7;
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 11px;
      color: #18191C;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .bili-secondary-btn:hover {
      background: #00AEEC;
      color: #FFFFFF;
      border-color: #00AEEC;
    }
    .bili-test-status {
      font-size: 11px;
      min-height: 16px;
      line-height: 1.4;
      margin-top: 2px;
    }
    .bili-test-status.success {
      color: #16A34A;
      font-weight: 600;
    }
    .bili-test-status.error {
      color: #DC2626;
      font-weight: 600;
    }
    .bili-test-status.testing {
      color: #D97706;
      font-weight: 600;
    }
    .bili-modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      background: #F6F7F8;
      border-top: 1px solid #F1F2F3;
    }
    .bili-btn-cancel {
      background: #FFFFFF;
      border: 1px solid #DCDFE6;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 12px;
      color: #61666D;
      cursor: pointer;
    }
    .bili-btn-cancel:hover {
      background: #F1F2F3;
    }
    .bili-btn-save {
      background: #00AEEC;
      border: 1px solid #00AEEC;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 12px;
      color: #FFFFFF;
      font-weight: 600;
      cursor: pointer;
    }
    .bili-btn-save:hover {
      background: #009CD8;
    }
    @keyframes bili-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
  `;

  function getCurrentPageBvid() {
    if (typeof window === 'undefined') return null;
    return parseBvidFromUrl(window.location.href);
  }

  let lastCurrentBtnState = '';
  function updateCurrentVideoBtn() {
    const btn = document.getElementById('bili-current-video-btn');
    if (!btn) return;
    const bvid = getCurrentPageBvid();
    if (!bvid) {
      if (btn.style.display !== 'none') btn.style.display = 'none';
      lastCurrentBtnState = '';
      return;
    }
    if (btn.style.display !== 'inline-flex') btn.style.display = 'inline-flex';
    const task = store.getTask(bvid);
    const status = task ? task.status : 'none';
    const stateKey = `${bvid}_${status}`;
    if (stateKey === lastCurrentBtnState) return;
    lastCurrentBtnState = stateKey;

    if (task && task.status === TaskStatus.COMPLETED) {
      btn.innerHTML = `<span>📑 查看总结</span>`;
      btn.classList.add('completed-state');
    } else if (task && (task.status === TaskStatus.EXTRACTING || task.status === TaskStatus.SUMMARIZING)) {
      btn.innerHTML = `<span>⏳ 总结中...</span>`;
      btn.classList.remove('completed-state');
    } else {
      btn.innerHTML = `<span>⚡ 总结当前</span>`;
      btn.classList.remove('completed-state');
    }
  }

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

  // ==========================================
  // 7. UI 初始化与事件驱动
  // ==========================================
  let activeDetailBvid = null;
  let isDockFullscreen = false;
  let savedDockWidth = '480px';

  function formatTaskTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m}-${day} ${h}:${min}`;
  }

  function initFloatBtnDrag(floatBtn) {
    const savedTop = gmStorageGet('bili_review_float_top');
    if (savedTop) {
      floatBtn.style.top = savedTop;
      floatBtn.style.transform = 'translateY(0)';
    }

    let isDragging = false;
    let startY = 0;
    let startTop = 0;
    let moved = false;

    floatBtn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // 仅限左键
      isDragging = true;
      moved = false;
      startY = e.clientY;
      const rect = floatBtn.getBoundingClientRect();
      startTop = rect.top;

      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        const dy = moveEvent.clientY - startY;
        if (Math.abs(dy) > 3) {
          if (!moved) {
            moved = true;
            floatBtn.classList.add('dragging');
            floatBtn.style.transition = 'none';
          }
        }

        if (moved) {
          const newTop = startTop + dy;
          const maxTop = window.innerHeight - floatBtn.offsetHeight - 16;
          const clampedTop = Math.min(Math.max(16, newTop), maxTop);
          floatBtn.style.top = `${clampedTop}px`;
          floatBtn.style.transform = 'translateY(0)';
        }
      };

      const onMouseUp = () => {
        if (!isDragging) return;
        isDragging = false;
        floatBtn.classList.remove('dragging');
        floatBtn.style.transition = '';

        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        if (moved) {
          const finalRect = floatBtn.getBoundingClientRect();
          const topPercent = `${((finalRect.top / window.innerHeight) * 100).toFixed(2)}%`;
          gmStorageSet('bili_review_float_top', topPercent);
        }
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    floatBtn.addEventListener('click', (e) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
        return;
      }
      e.stopPropagation();
      toggleDock();
    });
  }

  function initUI() {
    savedDockWidth = gmStorageGet('bili_review_dock_width', '480px');

    const styleEl = document.createElement('style');
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);

    const floatBtn = document.createElement('div');
    floatBtn.id = 'bili-review-float-btn';
    floatBtn.title = '展开/收起总结列表 (可上下拖拽调整位置，按 Tab 键)';
    floatBtn.innerHTML = `<span>📑 总结</span><kbd class="bili-float-kbd">Tab</kbd><span id="bili-review-badge">0</span>`;
    document.body.appendChild(floatBtn);

    initFloatBtnDrag(floatBtn);

    const drawer = document.createElement('div');
    drawer.id = 'bili-review-drawer';
    drawer.style.width = savedDockWidth;
    drawer.innerHTML = `
      <div id="bili-drawer-resizer" title="拖动调整列表宽度"></div>
      <div class="bili-drawer-header">
        <div class="bili-drawer-title">
          <span>📊 视频总结</span>
          <button class="bili-header-pill-btn" id="bili-settings-btn" title="API 接入与模型设置">
            <span>⚙️ 设置</span>
          </button>
          <button class="bili-header-pill-btn bili-current-video-btn" id="bili-current-video-btn" style="display: none;" title="一键总结当前正在播放的视频">
            <span>⚡ 总结当前</span>
          </button>
        </div>
        <div class="bili-drawer-actions">
          <button class="bili-header-pill-btn" id="bili-fullscreen-btn" title="切换全屏 / 收起 (按 Tab 键)">
            <svg id="bili-fullscreen-icon" viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 8V3h5M17 8V3h-5M3 12v5h5M17 12v5h-5"/>
            </svg>
            <span id="bili-fullscreen-text">全屏</span>
            <kbd class="bili-kbd-badge">Tab</kbd>
          </button>
          <button class="bili-header-pill-btn" id="bili-close-btn" title="收起总结抽屉">
            <span style="font-size: 13px; line-height: 1;">✕</span>
            <span id="bili-close-text">关闭</span>
          </button>
        </div>
      </div>
      <div id="bili-task-list-view"></div>
      <div id="bili-summary-detail-view">
        <div class="bili-detail-toolbar">
          <button class="bili-back-btn" id="bili-back-to-list-btn">← 返回列表</button>
          <div class="bili-article-actions">
            <button class="bili-action-btn dev-btn" id="bili-dev-resummarize-btn" title="仅供开发者测试：重新抓取并生成总结">🔄 重新总结</button>
            <button class="bili-action-btn" id="bili-copy-md-btn">📋 复制 Markdown</button>
          </div>
        </div>
        <div class="bili-markdown-body" id="bili-detail-content"></div>
      </div>

      <!-- API 设置 Modal 弹窗 -->
      <div id="bili-settings-modal" class="bili-modal-backdrop" style="display: none;">
        <div class="bili-modal-card">
          <div class="bili-modal-header">
            <div class="bili-modal-title">⚙️ API 接入与模型配置</div>
            <button class="bili-modal-close" id="bili-cfg-close-btn">✕</button>
          </div>
          <div class="bili-modal-body">
            <div class="bili-form-group">
              <label class="bili-form-label">协议类型 (Protocol):</label>
              <div class="bili-radio-group">
                <label class="bili-radio-item">
                  <input type="radio" name="bili-cfg-type" value="anthropic" id="bili-cfg-type-anthropic" />
                  <span>Anthropic (Claude / 本地 62999)</span>
                </label>
                <label class="bili-radio-item">
                  <input type="radio" name="bili-cfg-type" value="openai" id="bili-cfg-type-openai" />
                  <span>OpenAI 兼容 (DeepSeek / GPT / Ollama)</span>
                </label>
              </div>
            </div>

            <div class="bili-form-group">
              <label class="bili-form-label" for="bili-cfg-url">接口地址 (Base URL):</label>
              <input type="text" class="bili-form-input" id="bili-cfg-url" placeholder="如 http://127.0.0.1:62999 或 https://api.deepseek.com" />
            </div>

            <div class="bili-form-group">
              <label class="bili-form-label" for="bili-cfg-key">API 密钥 (API Key / Token):</label>
              <div class="bili-input-with-btn">
                <input type="password" class="bili-form-input" id="bili-cfg-key" placeholder="sk-..." autocomplete="off" />
                <button type="button" class="bili-input-icon-btn" id="bili-cfg-toggle-key" title="显示/隐藏密钥">👁️</button>
              </div>
            </div>

            <div class="bili-form-group">
              <label class="bili-form-label" for="bili-cfg-model">模型名称 (Model):</label>
              <div class="bili-input-with-btn">
                <input type="text" class="bili-form-input" id="bili-cfg-model" list="bili-model-list" placeholder="如 claude-opus-4-8 或 deepseek-chat" />
                <datalist id="bili-model-list"></datalist>
                <button type="button" class="bili-secondary-btn" id="bili-cfg-test-btn" title="通过 /v1/models 测试连通并拉取模型列表">🔄 拉取并测试</button>
              </div>
              <div id="bili-cfg-test-status" class="bili-test-status"></div>
            </div>

            <div class="bili-form-group">
              <label class="bili-form-label" for="bili-cfg-tokens">单次最大 Token (Max Tokens):</label>
              <input type="number" class="bili-form-input" id="bili-cfg-tokens" placeholder="8192" value="8192" />
            </div>
          </div>
          <div class="bili-modal-footer">
            <button class="bili-btn-cancel" id="bili-cfg-cancel-btn">取消</button>
            <button class="bili-btn-save" id="bili-btn-save-btn">💾 保存配置</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);

    // 滚轮隔离
    drawer.addEventListener('wheel', (e) => {
      e.stopPropagation();
    }, { passive: true });

    // 顶部操作
    document.getElementById('bili-fullscreen-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });

    document.getElementById('bili-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeDock();
    });

    // 总结本视频按钮事件
    document.getElementById('bili-current-video-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const bvid = getCurrentPageBvid();
      if (!bvid) return;

      const existing = store.getTask(bvid);
      if (existing && existing.status === TaskStatus.COMPLETED) {
        activeDetailBvid = bvid;
        switchView('detail');
        renderDetailView(bvid);
        return;
      }

      if (existing && (existing.status === TaskStatus.EXTRACTING || existing.status === TaskStatus.SUMMARIZING)) {
        showToast('⏳ 当前视频正在后台总结中，完成后可点击查看');
        return;
      }

      const pageTitleEl = document.querySelector('h1.video-title, .video-info-title .tit, .video-title');
      const pageAuthorEl = document.querySelector('.up-name, .username, .up-info--name');
      const meta = {
        title: pageTitleEl ? pageTitleEl.textContent.trim() : bvid,
        author: pageAuthorEl ? pageAuthorEl.textContent.trim() : '',
        pic: ''
      };

      store.createTask(bvid, meta);
      showToast(`🚀 已将当前视频《${meta.title.slice(0, 12)}...》加入总结队列`);
      executeSummaryTask(bvid, meta);
    });

    // API 设置 Modal 逻辑
    const settingsModal = document.getElementById('bili-settings-modal');
    const statusEl = document.getElementById('bili-cfg-test-status');

    function openSettingsModal() {
      const cfg = getConfig();
      const isAnthropic = cfg.apiType === 'anthropic';
      document.getElementById('bili-cfg-type-anthropic').checked = isAnthropic;
      document.getElementById('bili-cfg-type-openai').checked = !isAnthropic;
      document.getElementById('bili-cfg-url').value = cfg.baseUrl || 'http://127.0.0.1:62999';
      document.getElementById('bili-cfg-key').value = cfg.apiKey || '';
      document.getElementById('bili-cfg-model').value = cfg.model || 'claude-opus-4-8';
      document.getElementById('bili-cfg-tokens').value = cfg.maxTokens || 8192;
      statusEl.className = 'bili-test-status';
      statusEl.textContent = '';
      settingsModal.style.display = 'flex';
    }

    function closeSettingsModal() {
      settingsModal.style.display = 'none';
    }

    document.getElementById('bili-settings-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsModal();
    });

    document.getElementById('bili-cfg-close-btn').addEventListener('click', closeSettingsModal);
    document.getElementById('bili-cfg-cancel-btn').addEventListener('click', closeSettingsModal);

    // 显隐密码
    document.getElementById('bili-cfg-toggle-key').addEventListener('click', () => {
      const keyInput = document.getElementById('bili-cfg-key');
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    // 连通测试并拉取模型
    document.getElementById('bili-cfg-test-btn').addEventListener('click', async () => {
      const url = document.getElementById('bili-cfg-url').value.trim();
      const key = document.getElementById('bili-cfg-key').value.trim();
      const isAnthropic = document.getElementById('bili-cfg-type-anthropic').checked;
      const apiType = isAnthropic ? 'anthropic' : 'openai';

      statusEl.className = 'bili-test-status testing';
      statusEl.textContent = '⏳ 正在连接 /v1/models 并拉取模型...';

      try {
        const res = await testConnectionAndFetchModels(url, key, apiType);
        const datalist = document.getElementById('bili-model-list');
        datalist.innerHTML = '';
        res.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m;
          datalist.appendChild(opt);
        });

        const currentModel = document.getElementById('bili-cfg-model').value.trim();
        if (!currentModel && res.models.length > 0) {
          document.getElementById('bili-cfg-model').value = res.models[0];
        }

        statusEl.className = 'bili-test-status success';
        statusEl.textContent = `✅ 连通成功！已加载 ${res.count} 个可用模型`;
        showToast(`✅ API 连通成功，已拉取 ${res.count} 个可用模型`);
      } catch (err) {
        statusEl.className = 'bili-test-status error';
        statusEl.textContent = `❌ 连通失败: ${err.message}`;
        showToast(`❌ API 连通失败: ${err.message}`);
      }
    });

    // 保存配置
    document.getElementById('bili-btn-save-btn').addEventListener('click', () => {
      const isAnthropic = document.getElementById('bili-cfg-type-anthropic').checked;
      const newCfg = {
        apiType: isAnthropic ? 'anthropic' : 'openai',
        baseUrl: document.getElementById('bili-cfg-url').value.trim() || 'http://127.0.0.1:62999',
        apiKey: document.getElementById('bili-cfg-key').value.trim(),
        model: document.getElementById('bili-cfg-model').value.trim() || 'claude-opus-4-8',
        maxTokens: parseInt(document.getElementById('bili-cfg-tokens').value, 10) || 8192
      };
      saveConfig(newCfg);
      closeSettingsModal();
      showToast('💾 API 配置已保存并实时生效');
    });

    document.getElementById('bili-back-to-list-btn').addEventListener('click', () => {
      switchView('list');
    });

    document.getElementById('bili-copy-md-btn').addEventListener('click', () => {
      if (!activeDetailBvid) return;
      const task = store.getTask(activeDetailBvid);
      if (task && task.summary) {
        navigator.clipboard.writeText(task.summary).then(() => {
          showToast('✅ 视频总结 Markdown 已复制到剪贴板');
        });
      }
    });

    // 开发者重新总结按钮（正文工具栏）
    document.getElementById('bili-dev-resummarize-btn').addEventListener('click', () => {
      if (!activeDetailBvid) return;
      const bvid = activeDetailBvid;
      const task = store.getTask(bvid);
      if (task) {
        showToast(`🔄 正在重新总结《${(task.title || bvid).slice(0, 10)}...》`);
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

    // 全局快捷键 Tab 3 态闭环轮转（关闭 -> 小屏 -> 全屏 -> 关闭）
    document.addEventListener('keydown', (e) => {
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || document.activeElement?.isContentEditable) {
        return;
      }

      if (e.key === 'Tab') {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();

        if (!drawer.classList.contains('open')) {
          // 状态 1: 关闭 -> 打开小屏
          openDock(false);
        } else if (!isDockFullscreen) {
          // 状态 2: 小屏 -> 切换全屏
          setDockFullscreen(true);
        } else {
          // 状态 3: 全屏 -> 关闭抽屉
          closeDock();
        }
      } else if (e.key === 'Escape') {
        // 取消 Esc 关闭 Dock，仅在设置弹窗打开时关闭设置弹窗
        const modal = document.getElementById('bili-settings-modal');
        if (modal && modal.style.display !== 'none') {
          e.preventDefault();
          closeSettingsModal();
        }
      }
    });

    // 左边缘拖拽调整大小
    initResizerDrag(drawer);

    store.subscribe(() => {
      renderTaskList();
      updateBadge();
      updateCurrentVideoBtn();
      if (activeDetailBvid) {
        renderDetailView(activeDetailBvid);
      }
    });

    renderTaskList();
    updateBadge();
    updateCurrentVideoBtn();

    // 1 秒轻量级定时器：实时跳动生成中任务的耗时秒数，无需重新渲染整个 DOM
    setInterval(() => {
      const runningBadges = document.querySelectorAll('.bili-status-badge.summarizing');
      if (runningBadges.length > 0) {
        runningBadges.forEach((el) => {
          const bvid = el.getAttribute('data-bvid');
          const t = store.getTask(bvid);
          if (t && t.status === TaskStatus.SUMMARIZING) {
            const elapsed = Math.max(1, Math.round((Date.now() - (t.startTime || t.updatedAt)) / 1000));
            el.textContent = `🤖 ${elapsed}s...`;
          }
        });
      }
    }, 1000);
  }

  function openDock(fullscreen = false) {
    const drawer = document.getElementById('bili-review-drawer');
    if (!drawer) return;
    drawer.classList.add('open');
    setDockFullscreen(fullscreen);
    updateCurrentVideoBtn();
    renderTaskList();
  }

  function closeDock() {
    const drawer = document.getElementById('bili-review-drawer');
    if (!drawer) return;
    drawer.classList.remove('open');
    setDockFullscreen(false);
    document.body.style.overflow = '';
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
      document.body.style.overflow = 'hidden';
      if (textEl) textEl.textContent = '收起';
      if (iconEl) {
        iconEl.innerHTML = `
          <path d="M8 3v5H3M12 3v5h5M8 17v-5H3M12 17v-5h5"/>
        `;
      }
    } else {
      drawer.classList.remove('fullscreen');
      document.body.style.overflow = '';
      drawer.style.width = savedDockWidth || '480px';
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
          暂无总结任务<br>
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
          badgeText = '✅ 待查看';
        } else if (t.status === TaskStatus.SUMMARIZING) {
          const elapsed = Math.max(1, Math.round((Date.now() - (t.startTime || t.updatedAt)) / 1000));
          badgeText = `🤖 ${elapsed}s...`;
        } else if (t.status === TaskStatus.EXTRACTING) {
          badgeText = '⏳ 抓取中...';
        } else if (t.status === TaskStatus.INTERRUPTED) {
          badgeText = '⚠️ 已中断';
        } else if (t.status === TaskStatus.FAILED) {
          const isNoSub = t.error && (t.error.includes('字幕') || t.error.includes('暂未生成 AI 字幕'));
          badgeText = isNoSub ? '❌ 无AI字幕' : '❌ 失败';
        }

        const durationStr = (t.status === TaskStatus.COMPLETED && t.duration) ? ` · 耗时 ${t.duration}s` : '';
        const timePrefix = t.status === TaskStatus.COMPLETED ? '总结于' : '创建于';

        return `
        <div class="bili-task-card" data-bvid="${t.bvid}">
          <button class="bili-task-del-btn" data-bvid="${t.bvid}" title="删除记录">✕</button>
          <img class="bili-task-cover" src="${t.pic || '//i0.hdslb.com/bfs/archive/placeholder.jpg'}" alt="cover" />
          <div class="bili-task-meta">
            <a class="bili-task-title" href="https://www.bilibili.com/video/${t.bvid}" target="_blank" rel="noopener noreferrer" title="点击在 B 站打开原视频: ${escapeHtml(t.title)}">${escapeHtml(t.title)}</a>
            <div class="bili-task-footer">
              <span class="bili-task-author">${escapeHtml(t.author || t.bvid)}</span>
              <div style="display: flex; align-items: center; gap: 6px;">
                <button class="bili-dev-retry-btn" data-bvid="${t.bvid}" title="重新抓取并生成">🔄 重新总结</button>
                <span class="bili-status-badge ${badgeClass}" data-bvid="${t.bvid}">${badgeText}</span>
              </div>
            </div>
            <div class="bili-task-subfooter">
              <span class="bili-task-time" title="首次添加: ${formatTaskTime(t.createdAt)} / 上次更新: ${formatTaskTime(t.updatedAt)}">⏱️ ${timePrefix} ${formatTaskTime(t.updatedAt || t.createdAt)}${durationStr}</span>
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    // 点击卡片进入详情
    container.querySelectorAll('.bili-task-card').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.bili-task-del-btn') || e.target.closest('.bili-dev-retry-btn') || e.target.closest('.bili-task-title')) return;

        const bvid = el.getAttribute('data-bvid');
        const task = store.getTask(bvid);
        if (task && task.status === TaskStatus.COMPLETED) {
          activeDetailBvid = bvid;
          switchView('detail');
          renderDetailView(bvid);
        } else if (task && task.status === TaskStatus.INTERRUPTED) {
          executeSummaryTask(bvid, task);
        } else if (task && task.status === TaskStatus.FAILED) {
          if (confirm(`任务失败原因: ${task.error}\n\n是否重新尝试生成？`)) {
            executeSummaryTask(bvid, task);
          }
        } else {
          showToast('⏳ 正在后台生成总结，完成后即可点击查看');
        }
      });
    });

    // 开发者重新总结按钮（卡片列表）
    container.querySelectorAll('.bili-dev-retry-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const bvid = btn.getAttribute('data-bvid');
        const task = store.getTask(bvid);
        if (task) {
          showToast(`🔄 正在重新总结《${(task.title || bvid).slice(0, 10)}...》`);
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
          showToast('🗑️ 任务已删除');
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
      '.bili-video-card',
      '.feed-card',
      '.video-card',
      '.rank-item'
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
        <span class="bili-review-btn-text">AI 总结</span>
      `;
      btn.setAttribute('title', 'AI 视频总结（字幕 + 弹幕 + 评论）');
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
        showToast(`🚀 已将《${meta.title.slice(0, 12)}...》加入总结队列`);
        executeSummaryTask(bvid, meta);
      });

      coverWrap.appendChild(btn);
    });
  }

  // ==========================================
  // 9. 启动入口（带 250ms 防抖限频节流保护）
  // ==========================================
  function main() {
    initUI();
    scanAndInjectVideoCards();

    let scanTimer = null;
    let lastUrl = typeof window !== 'undefined' ? window.location.href : '';

    const observer = new MutationObserver(() => {
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        scanAndInjectVideoCards();
        if (typeof window !== 'undefined' && window.location.href !== lastUrl) {
          lastUrl = window.location.href;
          updateCurrentVideoBtn();
        }
      }, 250);
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
