import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, getSystemPrompt } from '../src/prompt.js';

describe('Prompt Builder - Seam 2', () => {
  describe('getSystemPrompt', () => {
    it('returns system prompt containing core bili-review principles', () => {
      const sysPrompt = getSystemPrompt();
      assert.ok(sysPrompt.includes('情报研报'));
      assert.ok(sysPrompt.includes('信度'));
      assert.ok(sysPrompt.includes('构度'));
      assert.ok(sysPrompt.includes('达度'));
      assert.ok(sysPrompt.includes('效度'));
    });
  });

  describe('buildReviewPrompt', () => {
    it('builds full user prompt with metadata, subtitles and comments', () => {
      const videoInfo = {
        title: '2026年最新AI工具深度测评',
        author: '科技UP主',
        pubdate: '2026-08-20',
        bvid: 'BV1abc123456'
      };
      const subtitles = '[00:00] 大家好，今天测试这款AI神器。\n[01:00] 速度非常快。';
      const comments = '1. [2026-08-21] [点赞 50] 用户A: 实际测试中发现API收费较贵。\n   └ 楼中楼1. [2026-08-21] 用户B: 确实，而且文档有错。';

      const prompt = buildReviewPrompt(videoInfo, subtitles, comments);

      assert.ok(prompt.includes('视频标题: 2026年最新AI工具深度测评'));
      assert.ok(prompt.includes('UP主: 科技UP主'));
      assert.ok(prompt.includes('发布时间: 2026-08-20'));
      assert.ok(prompt.includes('【视频字幕/文稿内容】'));
      assert.ok(prompt.includes('【评论区与楼中楼实测检验】'));
      assert.ok(prompt.includes('用户A: 实际测试中发现API收费较贵'));
    });

    it('builds tri-source prompt when danmaku summary is provided', () => {
      const videoInfo = {
        title: '2026年最新AI工具深度测评',
        author: '科技UP主',
        pubdate: '2026-08-20',
        bvid: 'BV1abc123456'
      };
      const subtitles = '[00:00] 大家好，今天测试这款AI神器。';
      const danmaku = '【高能时序峰值 TOP】\n1. [00:00 - 00:30] 弹幕数: 40条\n【即时纠错 / 避坑预警】\n- [00:14] 这里UP说错了';
      const comments = '1. [2026-08-21] [点赞 50] 用户A: 评论内容';

      const prompt = buildReviewPrompt(videoInfo, subtitles, danmaku, comments);
      assert.ok(prompt.includes('【弹幕时序热点与即时反馈】'));
      assert.ok(prompt.includes('【高能时序峰值 TOP】'));
      assert.ok(prompt.includes('【视频字幕/文稿内容】'));
      assert.ok(prompt.includes('【评论区与楼中楼实测检验】'));
    });

    it('handles fallback when subtitles are empty', () => {
      const videoInfo = {
        title: '无字幕测试视频',
        author: '测试UP',
        pubdate: '2026-08-25',
        bvid: 'BV1test00000',
        desc: '视频简介内容'
      };

      const prompt = buildReviewPrompt(videoInfo, '', '暂无评论');
      assert.ok(prompt.includes('（该视频无官方/AI字幕，依据视频简介与元数据）'));
      assert.ok(prompt.includes('视频简介内容'));
    });
  });
});

