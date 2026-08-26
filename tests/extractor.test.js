import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBvidFromUrl,
  formatTimestamp,
  formatSubtitleList,
  formatCommentsList
} from '../src/extractor.js';

describe('Bilibili Extractor - Seam 1', () => {
  describe('parseBvidFromUrl', () => {
    it('extracts BV id from standard video URL', () => {
      const url = 'https://www.bilibili.com/video/BV1YRhM64Eni/?spm_id_from=333.1007';
      assert.strictEqual(parseBvidFromUrl(url), 'BV1YRhM64Eni');
    });

    it('extracts BV id from protocol-relative URL', () => {
      const url = '//www.bilibili.com/video/BV1xx411c7mD';
      assert.strictEqual(parseBvidFromUrl(url), 'BV1xx411c7mD');
    });

    it('extracts BV id from path only', () => {
      const url = '/video/BV1234567890';
      assert.strictEqual(parseBvidFromUrl(url), 'BV1234567890');
    });

    it('returns null for non-video or invalid URLs', () => {
      assert.strictEqual(parseBvidFromUrl('https://www.bilibili.com/anime/index'), null);
      assert.strictEqual(parseBvidFromUrl(''), null);
      assert.strictEqual(parseBvidFromUrl(null), null);
    });
  });

  describe('formatTimestamp', () => {
    it('formats unix timestamp (seconds) to YYYY-MM-DD', () => {
      const ts = 1756080000; // 2025-08-25
      const formatted = formatTimestamp(ts);
      assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);
    });

    it('handles millisecond timestamps gracefully', () => {
      const tsMs = 1756080000000;
      const formatted = formatTimestamp(tsMs);
      assert.match(formatted, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('formatSubtitleList', () => {
    it('formats subtitle body items to timestamped transcript lines', () => {
      const body = [
        { from: 0.5, to: 2.1, content: '大家好' },
        { from: 65.2, to: 68.0, content: '今天我们来测评这款产品' }
      ];
      const result = formatSubtitleList(body);
      assert.strictEqual(
        result,
        '[00:00] 大家好\n[01:05] 今天我们来测评这款产品'
      );
    });

    it('deduplicates overlapping realtime speech recognition fragments', () => {
      const body = [
        { from: 0.5, to: 1.0, content: '今天' },
        { from: 1.0, to: 1.8, content: '今天我们' },
        { from: 1.8, to: 3.0, content: '今天我们来测评' },
        { from: 3.0, to: 4.5, content: '这款全新的大模型。' }
      ];
      const result = formatSubtitleList(body);
      assert.strictEqual(
        result,
        '[00:00] 今天我们来测评这款全新的大模型。'
      );
    });

    it('returns empty string when body is empty or invalid', () => {
      assert.strictEqual(formatSubtitleList([]), '');
      assert.strictEqual(formatSubtitleList(null), '');
    });
  });

  describe('formatCommentsList', () => {
    it('formats top-level and sub-replies into structured text', () => {
      const rawComments = [
        {
          rpid: 101,
          ctime: 1756080000,
          like: 120,
          member: { uname: '张三' },
          content: { message: '这个视频讲得太好了！' },
          replies: [
            {
              rpid: 201,
              ctime: 1756083600,
              like: 15,
              member: { uname: '李四' },
              content: { message: '确实，尤其是第二点。' }
            }
          ]
        }
      ];

      const output = formatCommentsList(rawComments);
      assert.ok(output.includes('1. ['));
      assert.ok(output.includes('张三: 这个视频讲得太好了！'));
      assert.ok(output.includes('└ 楼中楼1. ['));
      assert.ok(output.includes('李四: 确实，尤其是第二点。'));
    });
  });
});
