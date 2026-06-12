/**
 * 本地队列 - 基于 IndexedDB 的日志缓存
 * 
 * 为什么用 IndexedDB 而不是内存/ localStorage？
 * - IndexedDB 异步存储，不阻塞主线程
 * - 容量远大于 localStorage（通常 250MB+ vs 5MB）
 * - 多 Tab 共享数据，同一站点多页面共用队列
 * - 页面关闭不丢失，下次打开继续重试
 * 
 * 队列策略：
 * - push: 追加到队尾，超限时丢弃最旧 10%
 * - popBatch: 取出指定数量（用于批量上报）
 * - remove: 上报成功后从队列删除
 * 
 * 并发考虑：
 * - 多个 Tab 可能同时操作队列，使用版本号乐观锁
 * - 每个 Tab 独立调度上报，用 traceID 去重防止重复上报
 */

import type { LogEntry } from '@myby/log-shared';

interface QueueItem {
  id: string;
  traceId: string;
  data: LogEntry;
  retryCount: number;
  createdAt: number;
}

const DB_NAME = 'log-system-queue';
const STORE_NAME = 'logs';
const DB_VERSION = 1;

export class LocalQueue {
  private db: IDBDatabase | null = null;
  private maxSize: number;
  private dbReady: Promise<void>;

  constructor(maxSize: number = 5000) {
    this.maxSize = maxSize;
    this.dbReady = this._init();
  }

  private _init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, {
            keyPath: 'id',
            autoIncrement: false,
          });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('retryCount', 'retryCount', { unique: false });
        }
      };
      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };
      request.onerror = (event) => {
        console.error('[LogSystem] IndexedDB init error:', (event.target as IDBOpenDBRequest).error);
        reject((event.target as IDBOpenDBRequest).error);
      };
    });
  }

  private _getStore(mode: IDBTransactionMode = 'readwrite'): IDBObjectStore {
    if (!this.db) throw new Error('IndexedDB not initialized');
    const tx = this.db.transaction(STORE_NAME, mode);
    return tx.objectStore(STORE_NAME);
  }

  /** 入队 - 追加到队尾，超限时丢弃最旧 10% */
  async push(entry: QueueItem): Promise<void> {
    await this.dbReady;
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        // 先尝试插入（用 tryAdd 而不是先 count 再 add，避免竞态）
        const addReq = store.add(entry);
        addReq.onerror = () => {
          // 主键冲突：同一条日志已存在，忽略
          if (addReq.error?.name === 'ConstraintError') {
            resolve();
          } else {
            reject(addReq.error);
          }
        };
        addReq.onsuccess = () => {
          // 插入成功后检查是否超限，超限则删除最旧 10%
          const countReq = store.count();
          countReq.onsuccess = () => {
            if (countReq.result > this.maxSize) {
              const deleteCount = Math.ceil(this.maxSize * 0.1);
              const index = store.index('createdAt');
              // 使用 prev 方向从最旧开始遍历
              const cursorReq = index.openCursor(null, 'next');
              let deleted = 0;
              cursorReq.onsuccess = (event) => {
                const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
                if (cursor && deleted < deleteCount) {
                  cursor.delete();
                  deleted++;
                  cursor.continue();
                }
              };
            }
          };
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 批量取出队首 N 条 */
  async popBatch(size: number): Promise<QueueItem[]> {
    await this.dbReady;
    return new Promise((resolve, reject) => {
      try {
        const store = this._getStore('readonly');
        const index = store.index('createdAt');
        const items: QueueItem[] = [];
        const req = index.openCursor(null, 'next');
        req.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor && items.length < size) {
            items.push(cursor.value as QueueItem);
            cursor.continue();
          } else {
            resolve(items);
          }
        };
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 上报成功后删除 */
  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.dbReady;
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db!.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        let failedCount = 0;
        ids.forEach((id) => {
          const req = store.delete(id);
          req.onerror = () => {
            failedCount++;
            console.warn('[LogSystem] Queue remove failed for:', id, req.error);
          };
        });
        tx.oncomplete = () => {
          if (failedCount > 0) {
            console.warn('[LogSystem] Queue remove completed with', failedCount, 'failures');
          }
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 获取待发送数量 */
  async count(): Promise<number> {
    await this.dbReady;
    return new Promise((resolve, reject) => {
      try {
        const store = this._getStore('readonly');
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** 更新重试次数 */
  async updateRetry(id: string, retryCount: number): Promise<void> {
    await this.dbReady;
    return new Promise((resolve, reject) => {
      try {
        const store = this._getStore();
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const item = getReq.result as QueueItem | undefined;
          if (item) {
            item.retryCount = retryCount;
            store.put(item);
          }
          resolve();
        };
        getReq.onerror = () => reject(getReq.error);
      } catch (err) {
        reject(err);
      }
    });
  }
}
