/**
 * 命令队列（简化版）
 *
 * OpenClaw 使用 lane 级队列保证会话串行、避免并发交错。
 * mini 版本保留“每个 session 一个 lane + 全局 lane”的最小模型。
 */

type QueueEntry<T> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type LaneState = {
  active: number;
  queue: Array<QueueEntry<unknown>>;
  maxConcurrent: number;
  draining: boolean;
};

const lanes = new Map<string, LaneState>();

function getLaneState(lane: string): LaneState {
  const existing = lanes.get(lane);
  if (existing) {
    return existing;
  }
  const created: LaneState = {
    active: 0,
    queue: [],
    maxConcurrent: 1,
    draining: false,
  };
  lanes.set(lane, created);
  return created;
}

function drainLane(lane: string) {
  const state = getLaneState(lane);
  if (state.draining) {
    return;
  }
  state.draining = true;

  const pump = () => {
    while (state.active < state.maxConcurrent && state.queue.length > 0) {
      const entry = state.queue.shift() as QueueEntry<unknown>;
      state.active += 1;
      void (async () => {
        try {
          const result = await entry.task();
          state.active -= 1;
          pump();
          entry.resolve(result);
        } catch (err) {
          state.active -= 1;
          pump();
          entry.reject(err);
        }
      })();
    }
    state.draining = false;
  };

  pump();
}

export function setLaneConcurrency(lane: string, maxConcurrent: number) {
  const state = getLaneState(lane);
  state.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  drainLane(lane);
}

export function enqueueInLane<T>(lane: string, task: () => Promise<T>): Promise<T> {
  const state = getLaneState(lane);
  return new Promise<T>((resolve, reject) => {
    state.queue.push({
      task,
      resolve: (value) => resolve(value as T),
      reject,
    });
    drainLane(lane);
  });
}

export function resolveSessionLane(sessionKey: string): string {
  const cleaned = sessionKey.trim() || "main";
  return cleaned.startsWith("session:") ? cleaned : `session:${cleaned}`;
}

export function resolveGlobalLane(lane?: string): string {
  const cleaned = lane?.trim();
  return cleaned ? cleaned : "global";
}
