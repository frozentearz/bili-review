/**
 * Bilibili 视频总结 Prompt 组装模块 (bili-review 2.1)
 * 严格对齐 SKILL.md 规范
 */

export function getSystemPrompt() {
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
5. 独立客观：直接输出视频总结内容，严禁输出任何问候语、对话开场白或人称称呼。`;
}

/**
 * 清理供 Mermaid 节点使用的安全文本
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMermaidText(text) {
  return String(text || '')
    .replace(/["'\[\]\(\)\{\}\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

/**
 * 组装视频总结用户 Prompt
 * @param {{title: string, author: string, pubdate: string, bvid: string, desc?: string}} videoInfo
 * @param {string} subtitleText
 * @param {string} danmakuOrCommentsText 弹幕摘要文本（4参时）或评论文本（3参时）
 * @param {string} [commentsText] 评论文本（4参时）
 * @returns {string}
 */
export function buildReviewPrompt(videoInfo, subtitleText, danmakuOrCommentsText, commentsText) {
  const title = videoInfo?.title || '未知视频';
  const author = videoInfo?.author || '未知UP主';
  const pubdate = videoInfo?.pubdate || '未知时间';
  const bvid = videoInfo?.bvid || '';
  const desc = videoInfo?.desc || '无简介';

  let danmakuSummary = '';
  let finalComments = '';

  if (commentsText !== undefined) {
    danmakuSummary = danmakuOrCommentsText || '';
    finalComments = commentsText || '';
  } else {
    finalComments = danmakuOrCommentsText || '';
  }

  if (!subtitleText || !subtitleText.trim()) {
    throw new Error('该视频Bilibili官方暂未生成 AI 字幕，不支持总结');
  }
  const contentSection = subtitleText.trim();

  const safeComments = finalComments && finalComments.trim() ? finalComments.trim() : '暂无精选评论';

  const danmakuSection = danmakuSummary && danmakuSummary.trim()
    ? `\n=== 【弹幕时序热点与即时反馈】 ===\n${danmakuSummary.trim()}\n`
    : '';

  return `请根据以下 B 站视频三源数据，严格按照 bili-review 输出契约规范生成结构化视频总结：

=== 视频元数据 ===
- 视频标题: ${title}
- UP主: ${author}
- 发布时间: ${pubdate}
- BV号: ${bvid}
- 视频链接: https://www.bilibili.com/video/${bvid}

=== 【视频字幕/文稿内容】 ===
${contentSection}
${danmakuSection}
=== 【评论区与楼中楼讨论】 ===
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
