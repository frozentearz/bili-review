import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDanmakuXml,
  analyzeDanmaku,
  formatDanmakuSummary
} from '../src/extractor.js';

describe('Danmaku Extractor & Analyzer', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <chatid>12345678</chatid>
  <d p="10.50000,1,25,16777215,1700000000,0,a1b2c3d4,10001">第一条弹幕，前方高能！</d>
  <d p="12.20000,1,25,16777215,1700000002,0,a1b2c3d4,10002">高能高能！</d>
  <d p="13.10000,1,25,16777215,1700000003,0,a1b2c3d5,10003">前方高能</d>
  <d p="14.00000,1,25,16777215,1700000004,0,a1b2c3d6,10004">这里UP说错了，其实是2026年发布的</d>
  <d p="65.30000,1,25,16777215,1700000010,0,a1b2c3d7,10005">避坑，千万别买这个配置</d>
  <d p="66.00000,1,25,16777215,1700000011,0,a1b2c3d8,10006">翻车了哈哈哈哈</d>
  <d p="67.50000,1,25,16777215,1700000012,0,a1b2c3d9,10007">哈哈哈翻车了</d>
  <d p="120.00000,1,25,16777215,1700000020,0,a1b2c3e1,10008">完结撒花</d>
</i>`;

  describe('parseDanmakuXml', () => {
    it('correctly parses XML danmaku items with time and attributes', () => {
      const list = parseDanmakuXml(sampleXml);
      assert.strictEqual(list.length, 8);
      assert.strictEqual(list[0].time, 10.5);
      assert.strictEqual(list[0].text, '第一条弹幕，前方高能！');
      assert.strictEqual(list[0].dmid, '10001');
      assert.strictEqual(list[3].text, '这里UP说错了，其实是2026年发布的');
    });

    it('returns empty array when XML is empty or invalid', () => {
      assert.deepStrictEqual(parseDanmakuXml(''), []);
      assert.deepStrictEqual(parseDanmakuXml(null), []);
      assert.deepStrictEqual(parseDanmakuXml('invalid xml string'), []);
    });
  });

  describe('analyzeDanmaku', () => {
    it('identifies time-bucket spikes and buzzwords', () => {
      const list = parseDanmakuXml(sampleXml);
      const analysis = analyzeDanmaku(list, { bucketSeconds: 30, topSpikes: 3 });

      assert.strictEqual(analysis.total, 8);
      assert.ok(analysis.highlights.length > 0);

      // [00:00 - 00:30] contains 4 danmakus
      const firstPeak = analysis.highlights.find((h) => h.startTime === 0);
      assert.ok(firstPeak);
      assert.strictEqual(firstPeak.count, 4);
      assert.strictEqual(firstPeak.timeRange, '[00:00 - 00:30]');
    });

    it('extracts real-time corrections and warnings', () => {
      const list = parseDanmakuXml(sampleXml);
      const analysis = analyzeDanmaku(list);

      assert.ok(analysis.corrections.length >= 2);
      const errSample = analysis.corrections.find((c) => c.text.includes('说错了'));
      assert.ok(errSample);
      assert.strictEqual(errSample.timeFormatted, '[00:14]');

      const warningSample = analysis.corrections.find((c) => c.text.includes('避坑'));
      assert.ok(warningSample);
      assert.strictEqual(warningSample.timeFormatted, '[01:05]');
    });
  });

  describe('formatDanmakuSummary', () => {
    it('formats analysis into structured markdown text for Prompt', () => {
      const list = parseDanmakuXml(sampleXml);
      const analysis = analyzeDanmaku(list);
      const summaryText = formatDanmakuSummary(analysis);

      assert.ok(summaryText.includes('弹幕总量: 8 条'));
      assert.ok(summaryText.includes('【高能时序峰值 TOP】'));
      assert.ok(summaryText.includes('[00:00 - 00:30]'));
      assert.ok(summaryText.includes('【即时纠错 / 避坑预警 / 关键弹幕】'));
      assert.ok(summaryText.includes('[00:14] 这里UP说错了'));
    });

    it('handles empty analysis gracefully', () => {
      const summaryText = formatDanmakuSummary(null);
      assert.strictEqual(summaryText, '暂无弹幕时序数据');
    });
  });
});
