/**
 * Bilibili 双源情报研报 Prompt 组装模块 (bili-review 2.0)
 * 严格对齐 /Users/frazier/.gemini/config/skills/bili-review/SKILL.md 规范
 */

export function getSystemPrompt() {
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
 * 组装研报生成用户 Prompt
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

  const hasSubtitles = Boolean(subtitleText && subtitleText.trim());
  const contentSection = hasSubtitles
    ? subtitleText.trim()
    : `（该视频无官方/AI字幕，依据视频简介与元数据）\n简介内容：${desc}`;

  const safeComments = finalComments && finalComments.trim() ? finalComments.trim() : '暂无精选评论';

  const danmakuSection = danmakuSummary && danmakuSummary.trim()
    ? `\n=== 【弹幕时序热点与即时反馈】（群体情绪与时序证据） ===\n${danmakuSummary.trim()}\n`
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


