/**
 * 命令队列
 *
 * 对应 OpenClaw: src/process/command-queue.ts
 *
 * 两层 lane 设计:
 * - Session Lane (外层, maxConcurrent=1): 保证同一会话的请求串行，不交错
 * - Global Lane  (内层, 可配置并发): 控制跨 session 的总并发，防止 API 过载
 *
 * 嵌套顺序: enqueueSession(() => enqueueGlobal(() => { ... }))
 * - Session Lane 保证同一 session 不并发
 * - Global Lane 控制不同 session 之间的并行度
 * - 两层协作: session A 和 B 各自串行, 但可同时运行（取决于 global 并发数）
 */

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  warnAfterMs: number;
};

type LaneState = {
  lane: string;
  active: number;
  queue: Array<QueueEntry<unknown>>;
  maxConcurrent: number;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    lane,
    active: 0,
    queue: [],
    maxConcurrent: 1,
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);

  while (state.active < state.maxConcurrent && state.queue.length > 0) {
    const entry = state.queue.shift() as QueueEntry<unknown>;
    state.active += 1;

    const waitMs = Date.now() - entry.enqueuedAt;
    if (waitMs > entry.warnAfterMs && entry.onWait) {
      entry.onWait(waitMs, state.queue.length);
    }

    void (async () => {
      try {
        const result = await entry.task();
        state.active -= 1;
        drainLane(lane);
        entry.resolve(result);
      } catch (err) {
        state.active -= 1;
        drainLane(lane);
        entry.reject(err);
      }
    })();
  }
}

export function setLaneConcurrency(lane: string, maxConcurrent: number) {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(lane);
}

export interface EnqueueOpts {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
}

export function enqueueInLane<T>(
  lane: string,
  task: () => Promise<T>,
  opts?: EnqueueOpts,
): Promise<T> {
  const state = getLaneState(lane);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task: () => task(),
      resolve: (value) => resolve(value as T),
      reject,
      enqueuedAt: Date.now(),
      warnAfterMs: opts?.warnAfterMs ?? 2_000,
      onWait: opts?.onWait,
    });
    drainLane(lane);
  });
}

export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

/**
 * 清理指定 lane（队列为空且无活跃任务时从 Map 移除）
 *
 * 典型调用时机:
 * - session 结束后清理 session lane
 * - Agent 销毁前清理 global lane
 */
export function deleteLane(lane: string): boolean {
  const state = lanes.get(lane);
  if (!state) return false;
  if (state.active > 0 || state.queue.length > 0) return false;
  return lanes.delete(lane);
}

export function resolveGlobalLane(lane?: string): string {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "main";
}
