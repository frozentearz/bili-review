import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskStore, TaskStatus } from '../src/store.js';

describe('TaskStore - Seam 3', () => {
  let store;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('creates a task in pending state', () => {
    const task = store.createTask('BV1test12345', {
      title: '测试视频',
      author: 'UP主A',
      pic: 'https://example.com/cover.jpg'
    });

    assert.strictEqual(task.bvid, 'BV1test12345');
    assert.strictEqual(task.status, TaskStatus.PENDING);
    assert.strictEqual(task.title, '测试视频');
    assert.ok(task.createdAt > 0);
  });

  it('updates task state to extracting, summarizing, and completed', () => {
    store.createTask('BV1test12345', { title: '测试视频' });

    store.updateTask('BV1test12345', {
      status: TaskStatus.SUMMARIZING,
      progress: 'AI 正在深度思考...'
    });
    let task = store.getTask('BV1test12345');
    assert.strictEqual(task.status, TaskStatus.SUMMARIZING);
    assert.strictEqual(task.progress, 'AI 正在深度思考...');

    store.updateTask('BV1test12345', {
      status: TaskStatus.COMPLETED,
      summary: '# 视频总结正文内容',
      progress: '已完成'
    });
    task = store.getTask('BV1test12345');
    assert.strictEqual(task.status, TaskStatus.COMPLETED);
    assert.strictEqual(task.summary, '# 视频总结正文内容');
  });

  it('handles task failure gracefully', () => {
    store.createTask('BV1err00000', { title: '异常视频' });
    store.updateTask('BV1err00000', {
      status: TaskStatus.FAILED,
      error: 'API 连接超时'
    });

    const task = store.getTask('BV1err00000');
    assert.strictEqual(task.status, TaskStatus.FAILED);
    assert.strictEqual(task.error, 'API 连接超时');
  });

  it('serializes and deserializes task state for storage', () => {
    store.createTask('BV1item1', { title: '视频1' });
    store.createTask('BV1item2', { title: '视频2' });
    store.updateTask('BV1item1', { status: TaskStatus.COMPLETED, summary: '已完成' });

    const json = store.serialize();
    const newStore = new TaskStore();
    newStore.deserialize(json);

    assert.strictEqual(newStore.listTasks().length, 2);
    assert.strictEqual(newStore.getTask('BV1item1').status, TaskStatus.COMPLETED);
  });

  it('sorts tasks by createdAt descending and preserves order upon update', () => {
    const t1 = store.createTask('BV1old', { title: '旧任务' });
    t1.createdAt = 1000;
    const t2 = store.createTask('BV1new', { title: '新任务' });
    t2.createdAt = 2000;

    let list = store.listTasks();
    assert.strictEqual(list[0].bvid, 'BV1new');
    assert.strictEqual(list[1].bvid, 'BV1old');

    // 重新总结旧任务，即使 updatedAt 变大，列表顺序依然基于 createdAt 保持不变
    store.updateTask('BV1old', { status: TaskStatus.COMPLETED, summary: '最新总结' });
    list = store.listTasks();
    assert.strictEqual(list[0].bvid, 'BV1new');
    assert.strictEqual(list[1].bvid, 'BV1old');
  });
});
