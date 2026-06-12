/**
 * 链路ID生成工具
 * 
 * 链路追溯基于 traceID + spanID + parentSpanID 构建树形结构。
 * 
 * 生成策略：
 * - traceID：UUID v4，存入 sessionStorage 在单次会话复用。
 *   同一用户的一次操作全流程共享同一个 traceID。
 * - spanID：每次调用生成新的 UUID v4，标识当前环节。
 * - parentSpanID：上一个 spanID，形成调用链。
 */

const TRACE_KEY = '__log_trace_id__';

/** 生成 UUID v4 */
export function generateId(): string {
  const hex = '0123456789abcdef';
  let uuid = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-';
    } else if (i === 14) {
      uuid += '4';
    } else if (i === 19) {
      uuid += hex[(Math.random() * 4) | 8];
    } else {
      uuid += hex[(Math.random() * 16) | 0];
    }
  }
  return uuid;
}

/** 获取当前会话的 traceID，不存在则生成新 ID */
export function getOrCreateTraceId(): string {
  try {
    const stored = sessionStorage.getItem(TRACE_KEY);
    if (stored) return stored;
    const id = generateId();
    sessionStorage.setItem(TRACE_KEY, id);
    return id;
  } catch {
    // sessionStorage 不可用时（如无痕模式），直接生成
    return generateId();
  }
}

/** 手动设置 traceID（用于从 URL 参数或服务端下发） */
export function setTraceId(id: string): void {
  try {
    sessionStorage.setItem(TRACE_KEY, id);
  } catch {
    // ignore
  }
}

/** 生成新的 spanID */
export function generateSpanId(): string {
  return generateId();
}
