---
name: bili-review
description: B站视频总结：获取视频AI字幕总结+读取【评论区楼中楼】（痛点）并总结。AI字幕需要获取浏览器Cookie获取登录状态。触发词：B站视频总结、B站总结、B站评论、看评论区、视频讲了什么、B站深度分析。
version: 1.2.0
author: Frazier
metadata:
  openclaw:
    emoji: "📺"
    homepage: https://github.com/frozentearz/bili-review
    requires:
      bins:
        - yt-dlp
        - python3
    install:
      - id: brew
        kind: brew
        formula: yt-dlp
        bins:
          - yt-dlp
        label: Install yt-dlp (macOS)
      - id: pip
        kind: pip
        package: yt-dlp
        bins:
          - yt-dlp
        label: Install yt-dlp (Windows / Linux / macOS via pip)
---

# Bili-review

> 如果这个 skill 对你有用，欢迎 [⭐ Star](https://github.com/frozentearz/bili-review) 支持，遇到问题或建议请 [📝 提 Issue](https://github.com/frozentearz/bili-review/issues)。

B站视频深度总结：**视频AI字幕总结 + 评论区总结**，双维度输出。

- 字幕抓取走 `yt-dlp`（B站AI字幕，自动复用本地登录态）
- 评论抓取走 B 站公开 API（**免登录、免费、零第三方 API Key**）
- 登录态：首次自动从浏览器提取存本地 `cookies.txt`，**有效期约 150 天**，期间全自动复用
- 两个子功能可独立使用，也可合并输出

## 登录态机制

AI字幕（ai-*）需要 B 站登录态。本 skill 的登录方案：

```bash
python3 {baseDir}/scripts/bili_review.py login     # 首次: 从浏览器提取登录态(弹窗授权一次)
python3 {baseDir}/scripts/bili_review.py status    # 查看登录态状态/当前账号
```

- 自动探测多浏览器：chrome → edge → firefox → brave → chromium → opera → vivaldi → whale → safari，第一个有 B 站登录态的直接用
- mac 上 Chrome 系首次会弹钥匙串授权框，**点「始终允许」后永久免弹**；Firefox 永不弹窗；Win/Linux 大部分环境不弹窗
- 登录态存 `cookies.txt`，SESSDATA 有效期约 **150 天**；过期后下次执行 subtitle/all 自动重新提取
- 字幕抓取时若本地登录态有效，直接用，不再打扰浏览器

## 安全说明

- `cookies.txt` **仅包含 B 站相关域名的 cookie**（`bilibili.com` / `b23.tv` / `biligame.com` 等），绝不导出浏览器中其他网站的 cookie
- 文件权限为 `600`（仅当前用户可读）
- 该文件含 B 站登录凭证，请勿提交到 git、上传或分享；`.clawhubignore` 已排除发布

## 子功能

### 1. 视频字幕总结 (subtitle)

抓取视频 AI 字幕，交给 LLM 做分段总结。

```bash
python3 {baseDir}/scripts/bili_review.py subtitle "BV1GJ411x7h7"
# 也支持完整链接 / b23.tv 短链
python3 {baseDir}/scripts/bili_review.py subtitle "https://www.bilibili.com/video/BV1GJ411x7h7"
```

- 默认语言 `ai-zh`（B站AI中文字幕），可用 `--lang ai-en` 等切换
- 登录态失效时自动重新提取；提取失败则报错并提示运行 login
- 输出：`# 字幕` 头部 + 纯文本字幕内容，供 LLM 总结
- 抓取失败（无字幕/限流）会明确报错并给出重试建议

### 2. 评论区总结 (comments)

爬取视频评论区，输出结构化评论数据，交给 LLM 做评论总结与观点聚类。

```bash
python3 {baseDir}/scripts/bili_review.py comments "BV1GJ411x7h7" --limit 50
```

- `--limit N`：评论条数，默认 30，上限 50
- 排序规则：按点赞数从高到低（热门优先，比时间序更能代表民意）
- **楼中楼**：加 `--replies` 同时抓取每条热门评论的楼中楼回复（默认每条 5 条，`--replies-per N` 调整）
- 输出：视频元信息 + 评论列表（含楼中楼，作者 / 点赞 / 内容），供 LLM 总结
- 免登录，无需任何 API Key

### 3. 合并输出 (all)

字幕 + 评论一次抓完，一起交给 LLM。

```bash
python3 {baseDir}/scripts/bili_review.py all "BV1GJ411x7h7" --limit 30
```

## 标准工作流（Agent 执行）

拿到视频后按此流程产出最终报告：

1. 解析输入：BV 号 / `bilibili.com/video/` 链接 / `b23.tv` 短链均可
2. 抓字幕：`bili_review.py subtitle "<bvid>"`
3. 抓评论：`bili_review.py comments "<bvid>" --limit 30`
4. LLM 总结，报告结构：

```markdown
# 《视频标题》总结

## 视频内容总结
- 一句话概括
- 分段要点（基于字幕时间轴/段落）

## 评论区总结
- 总体情绪（正面/负面/中性，附依据）
- 高赞观点（按点赞权重列出，引用代表性评论）
- 观众关心的点 / 争议点
- 观众需求与建议（如有）
```

## 输出格式

### subtitle 输出

```markdown
# 视频: <title>
# BVID: <bvid>
# UP主: <author>
# 播放/点赞/评论: <stats>
# 字幕语言: zh-CN

<纯文本字幕，按句分行>
```

### comments 输出

```markdown
# 视频: <title>
# BVID: <bvid>
# UP主: <author>
# 评论总数: <count>

## 热门评论 TOP N
1. [点赞 xxx] <作者>: <内容>
2. [点赞 xxx] <作者>: <内容>
...
```

## 注意事项

- 字幕：依赖视频是否有 AI 字幕；`yt-dlp` 被 B 站限流时（HTTP 412）稍后重试
- 登录态：`cookies.txt` 存于 skill 根目录，含登录凭证，请勿外泄；有效期约 150 天，失效后自动重新提取
- 评论：公开接口单次最多 50 条，如需更多可调整 `--limit`；部分视频评论关闭则返回空
- 免费无依赖：不需要任何第三方 API Key，仅需 `yt-dlp` 和 `python3` 标准库
