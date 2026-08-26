/**
 * 任务状态机与队列管理模块
 */

export const TaskStatus = {
  PENDING: 'pending',
  EXTRACTING: 'extracting',
  SUMMARIZING: 'summarizing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

export class TaskStore {
  constructor() {
    this.tasks = new Map();
  }

  /**
   * 创建一个新总结任务
   * @param {string} bvid
   * @param {object} meta
   */
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
      progress: '排队中...',
      summary: '',
      error: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.tasks.set(bvid, task);
    return task;
  }

  /**
   * 更新任务状态
   * @param {string} bvid
   * @param {object} updates
   */
  updateTask(bvid, updates = {}) {
    const task = this.tasks.get(bvid);
    if (!task) return null;

    Object.assign(task, updates, { updatedAt: Date.now() });
    return task;
  }

  getTask(bvid) {
    return this.tasks.get(bvid) || null;
  }

  listTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deleteTask(bvid) {
    return this.tasks.delete(bvid);
  }

  clear() {
    this.tasks.clear();
  }

  serialize() {
    return JSON.stringify(Array.from(this.tasks.entries()));
  }

  deserialize(data) {
    if (!data) return;
    try {
      const entries = typeof data === 'string' ? JSON.parse(data) : data;
      if (Array.isArray(entries)) {
        this.tasks = new Map(entries);
      }
    } catch (e) {
      console.error('[TaskStore] 反序列化失败:', e);
    }
  }
}
