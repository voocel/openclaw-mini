/**
 * 主动唤醒机制 (Heartbeat)
 *
 * 基于 OpenClaw 源码的真实实现:
 *
 * 1. Heartbeat Runner (heartbeat-runner.ts)
 *    - setTimeout 精确调度 (非 setInterval)
 *    - 活跃时间窗口 (activeHours)
 *    - HEARTBEAT.md 空内容检测
 *    - 重复消息抑制 (24h)
 *
 * 2. Heartbeat Wake (heartbeat-wake.ts)
 *    - 事件驱动唤醒
 *    - 请求合并 (coalesce 250ms)
 *    - 双重缓冲 (运行中排队)
 *
 * 3. 多来源触发:
 *    - interval: 定时器到期
 *    - cron: 定时任务完成
 *    - exec: 命令执行完成
 *    - requested: 手动请求
 */

import fs from "node:fs/promises";
import path from "node:path";

// ============== 类型定义 ==============

export interface HeartbeatTask {
  description: string;
  completed: boolean;
  raw: string;
  line: number;
}

export interface ActiveHours {
  start: string; // "HH:MM" 格式
  end: string;
  timezone?: string; // 默认本地时区
}

export interface HeartbeatConfig {
  /** 检查间隔 (毫秒)，默认 30 分钟 */
  intervalMs?: number;
  /** HEARTBEAT.md 路径 */
  heartbeatPath?: string;
  /** 活跃时间窗口 */
  activeHours?: ActiveHours;
  /** 是否启用 */
  enabled?: boolean;
  /** 请求合并窗口 (毫秒)，默认 250ms */
  coalesceMs?: number;
  /** 重复检测窗口 (毫秒)，默认 24 小时 */
  duplicateWindowMs?: number;
}

export type WakeReason =
  | "interval"      // 定时器到期
  | "cron"          // Cron 任务完成
  | "exec"          // 命令执行完成
  | "requested"     // 手动请求
  | "retry";        // 重试

export interface WakeRequest {
  reason: WakeReason;
  source?: string; // 来源标识，如 "cron:job-123"
}

export interface HeartbeatResult {
  status: "ok" | "skipped" | "error";
  reason?: string;
  tasks?: HeartbeatTask[];
  text?: string;
}

export type HeartbeatHandler = (
  tasks: HeartbeatTask[],
  request: WakeRequest,
) => Promise<HeartbeatResult>;

// ============== Heartbeat Wake (请求合并层) ==============

interface WakeState {
  running: boolean;
  scheduled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pendingReason: WakeReason;
  pendingSource?: string;
}

/**
 * Heartbeat Wake - 请求合并和双重缓冲
 *
 * 核心机制:
 * 1. 多个请求在 coalesceMs 内合并为一次执行
 * 2. 如果正在运行，新请求排队等待
 * 3. 运行完成后，如果有排队请求，立即再次运行
 */
class HeartbeatWake {
  private state: WakeState = {
    running: false,
    scheduled: false,
    timer: null,
    pendingReason: "requested",
  };

  private handler: HeartbeatHandler | null = null;
  private coalesceMs: number;
  private retryMs = 1000;

  constructor(coalesceMs = 250) {
    this.coalesceMs = coalesceMs;
  }

  setHandler(handler: HeartbeatHandler): void {
    this.handler = handler;
  }

  /**
   * 请求立即唤醒
   * 多个请求会合并，原因优先级: exec > cron > interval > requested
   */
  request(req: WakeRequest): void {
    // 原因优先级合并
    this.state.pendingReason = this.mergeReason(
      this.state.pendingReason,
      req.reason,
    );
    if (req.source) {
      this.state.pendingSource = req.source;
    }

    this.schedule(this.coalesceMs);
  }

  private mergeReason(current: WakeReason, incoming: WakeReason): WakeReason {
    const priority: Record<WakeReason, number> = {
      exec: 4,
      cron: 3,
      interval: 2,
      retry: 1,
      requested: 0,
    };
    return priority[incoming] > priority[current] ? incoming : current;
  }

  private schedule(delayMs: number): void {
    // 如果已在运行，标记为已排队
    if (this.state.running) {
      this.state.scheduled = true;
      return;
    }

    // 如果已有定时器，不重复设置（合并）
    if (this.state.timer) {
      return;
    }

    this.state.timer = setTimeout(() => this.execute(), delayMs);
  }

  private async execute(): Promise<void> {
    this.state.timer = null;
    this.state.running = true;

    const request: WakeRequest = {
      reason: this.state.pendingReason,
      source: this.state.pendingSource,
    };

    // 重置 pending 状态
    this.state.pendingReason = "requested";
    this.state.pendingSource = undefined;
    this.state.scheduled = false;

    try {
      if (!this.handler) {
        return;
      }

      const result = await this.handler([], request);

      // 如果跳过且原因是队列繁忙，重试
      if (result.status === "skipped" && result.reason === "requests-in-flight") {
        this.state.pendingReason = "retry";
        this.schedule(this.retryMs);
      }
    } finally {
      this.state.running = false;

      // 如果运行期间有新请求排队，立即再次执行
      if (this.state.scheduled) {
        this.state.scheduled = false;
        this.schedule(0);
      }
    }
  }

  stop(): void {
    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
    this.state.scheduled = false;
  }
}

// ============== Heartbeat Runner (调度层) ==============

interface RunnerState {
  nextDueMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastRunAt: number | null;
  lastText: string | null;
  lastTextAt: number | null;
}

/**
 * Heartbeat Manager - 主动唤醒管理器
 *
 * 核心职责:
 * 1. 定时调度 (setTimeout 精确调度)
 * 2. 活跃时间窗口检查
 * 3. HEARTBEAT.md 解析和空内容检测
 * 4. 重复消息抑制
 * 5. 事件驱动唤醒 (通过 HeartbeatWake)
 */
export class HeartbeatManager {
  private workspaceDir: string;
  private config: Required<Omit<HeartbeatConfig, "activeHours">> & {
    activeHours?: ActiveHours;
  };

  private state: RunnerState = {
    nextDueMs: 0,
    timer: null,
    lastRunAt: null,
    lastText: null,
    lastTextAt: null,
  };

  private wake: HeartbeatWake;
  private callbacks: HeartbeatHandler[] = [];
  private started = false;

  constructor(workspaceDir: string, config: HeartbeatConfig = {}) {
    this.workspaceDir = workspaceDir;
    this.config = {
      intervalMs: config.intervalMs ?? 30 * 60 * 1000, // 30 分钟
      heartbeatPath: config.heartbeatPath ?? "HEARTBEAT.md",
      enabled: config.enabled ?? true,
      coalesceMs: config.coalesceMs ?? 250,
      duplicateWindowMs: config.duplicateWindowMs ?? 24 * 60 * 60 * 1000,
      activeHours: config.activeHours,
    };

    this.wake = new HeartbeatWake(this.config.coalesceMs);
    this.wake.setHandler((_, request) => this.runOnce(request));
  }

  // ============== 公共 API ==============

  /**
   * 启动 Heartbeat 监控
   */
  start(): void {
    if (!this.config.enabled || this.started) return;
    this.started = true;

    // 计算下一次运行时间
    this.scheduleNext();
  }

  /**
   * 停止 Heartbeat 监控
   */
  stop(): void {
    this.started = false;
    this.wake.stop();

    if (this.state.timer) {
      clearTimeout(this.state.timer);
      this.state.timer = null;
    }
  }

  /**
   * 注册回调
   */
  onTasks(callback: HeartbeatHandler): void {
    this.callbacks.push(callback);
  }

  /**
   * 请求立即唤醒 (事件驱动)
   */
  requestNow(reason: WakeReason = "requested", source?: string): void {
    this.wake.request({ reason, source });
  }

  /**
   * 手动触发检查 (同步等待)
   */
  async trigger(): Promise<HeartbeatTask[]> {
    const result = await this.runOnce({ reason: "requested" });
    return result.tasks ?? [];
  }

  // ============== 调度逻辑 ==============

  /**
   * 调度下一次运行 (setTimeout 精确调度)
   */
  private scheduleNext(): void {
    if (!this.started) return;

    const now = Date.now();
    const lastRun = this.state.lastRunAt ?? now;
    const nextDue = lastRun + this.config.intervalMs;

    this.state.nextDueMs = nextDue;

    const delay = Math.max(0, nextDue - now);

    this.state.timer = setTimeout(() => {
      this.wake.request({ reason: "interval" });
    }, delay);
  }

  /**
   * 执行一次 Heartbeat 检查
   */
  private async runOnce(request: WakeRequest): Promise<HeartbeatResult> {
    const now = Date.now();

    // 1. 活跃时间窗口检查
    if (!this.isWithinActiveHours(now)) {
      return { status: "skipped", reason: "outside-active-hours" };
    }

    // 2. 解析 HEARTBEAT.md
    const tasks = await this.parseTasks();
    const pending = tasks.filter((t) => !t.completed);

    // 3. 空内容检测 (exec 事件除外)
    if (pending.length === 0 && request.reason !== "exec") {
      this.state.lastRunAt = now;
      this.scheduleNext();
      return { status: "skipped", reason: "no-pending-tasks" };
    }

    // 4. 执行回调
    let resultText: string | undefined;
    for (const callback of this.callbacks) {
      try {
        const result = await callback(pending, request);
        if (result.text) {
          resultText = result.text;
        }
      } catch (err) {
        console.error("[Heartbeat] Callback error:", err);
      }
    }

    // 5. 重复消息抑制
    if (resultText && this.isDuplicateMessage(resultText, now)) {
      this.state.lastRunAt = now;
      this.scheduleNext();
      return { status: "skipped", reason: "duplicate-message", tasks: pending };
    }

    // 6. 更新状态
    this.state.lastRunAt = now;
    if (resultText) {
      this.state.lastText = resultText;
      this.state.lastTextAt = now;
    }

    // 7. 调度下一次
    this.scheduleNext();

    return { status: "ok", tasks: pending, text: resultText };
  }

  // ============== 辅助方法 ==============

  /**
   * 检查是否在活跃时间窗口内
   */
  private isWithinActiveHours(nowMs: number): boolean {
    const { activeHours } = this.config;
    if (!activeHours) return true;

    const date = new Date(nowMs);
    const currentMinutes = date.getHours() * 60 + date.getMinutes();

    const [startH, startM] = activeHours.start.split(":").map(Number);
    const [endH, endM] = activeHours.end.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // 处理跨午夜的情况
    if (endMinutes <= startMinutes) {
      // 例如 22:00 - 06:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  /**
   * 检查是否是重复消息 (24h 内)
   */
  private isDuplicateMessage(text: string, nowMs: number): boolean {
    if (!this.state.lastText || !this.state.lastTextAt) {
      return false;
    }

    const timeSinceLast = nowMs - this.state.lastTextAt;
    if (timeSinceLast >= this.config.duplicateWindowMs) {
      return false;
    }

    return text.trim() === this.state.lastText.trim();
  }

  /**
   * 获取 HEARTBEAT.md 路径
   */
  private getHeartbeatPath(): string {
    if (path.isAbsolute(this.config.heartbeatPath)) {
      return this.config.heartbeatPath;
    }
    return path.join(this.workspaceDir, this.config.heartbeatPath);
  }

  /**
   * 解析 HEARTBEAT.md 任务
   */
  async parseTasks(): Promise<HeartbeatTask[]> {
    const filePath = this.getHeartbeatPath();
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return this.parseTasksFromContent(content);
    } catch {
      return [];
    }
  }

  /**
   * 从内容解析任务
   */
  private parseTasksFromContent(content: string): HeartbeatTask[] {
    const lines = content.split("\n");
    const tasks: HeartbeatTask[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // 跳过空行和标题
      if (!trimmed || /^#+\s/.test(trimmed)) continue;

      // checkbox 格式: - [ ] 或 - [x]
      const checkboxMatch = trimmed.match(/^[-*+]\s*\[([\sXx]?)\]\s*(.+)$/);
      if (checkboxMatch) {
        const [, check, description] = checkboxMatch;
        tasks.push({
          description: description.trim(),
          completed: check.toLowerCase() === "x",
          raw: line,
          line: i + 1,
        });
        continue;
      }

      // 普通列表格式: - item
      const listMatch = trimmed.match(/^[-*+]\s+(.+)$/);
      if (listMatch) {
        const [, description] = listMatch;
        if (!/^\s*$/.test(description)) {
          tasks.push({
            description: description.trim(),
            completed: false,
            raw: line,
            line: i + 1,
          });
        }
      }
    }

    return tasks;
  }

  /**
   * 获取未完成任务
   */
  async getPendingTasks(): Promise<HeartbeatTask[]> {
    const tasks = await this.parseTasks();
    return tasks.filter((t) => !t.completed);
  }

  /**
   * 检查是否有待办任务
   */
  async hasPendingTasks(): Promise<boolean> {
    const pending = await this.getPendingTasks();
    return pending.length > 0;
  }

  /**
   * 标记任务完成
   */
  async markCompleted(lineNumber: number): Promise<boolean> {
    const filePath = this.getHeartbeatPath();
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const lines = content.split("\n");

      if (lineNumber < 1 || lineNumber > lines.length) {
        return false;
      }

      const line = lines[lineNumber - 1];
      const updated = line.replace(/\[\s?\]/, "[x]");

      if (updated === line) {
        return false;
      }

      lines[lineNumber - 1] = updated;
      await fs.writeFile(filePath, lines.join("\n"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 添加任务
   */
  async addTask(description: string): Promise<void> {
    const filePath = this.getHeartbeatPath();
    try {
      let content = "";
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        content = "# Heartbeat Tasks\n\n";
      }

      const task = `- [ ] ${description}\n`;
      content = content.trimEnd() + "\n" + task;

      await fs.writeFile(filePath, content);
    } catch (err) {
      throw new Error(`Failed to add task: ${(err as Error).message}`);
    }
  }

  /**
   * 构建任务提示
   */
  async buildTasksPrompt(): Promise<string> {
    const pending = await this.getPendingTasks();
    if (pending.length === 0) return "";

    const lines = pending.map((t, i) => `${i + 1}. ${t.description}`);
    return `\n\n## 待办任务 (HEARTBEAT.md)\n\n${lines.join("\n")}\n\n请优先处理这些任务。`;
  }

  /**
   * 更新配置 (热加载)
   */
  updateConfig(config: Partial<HeartbeatConfig>): void {
    if (config.intervalMs !== undefined) {
      this.config.intervalMs = config.intervalMs;
    }
    if (config.activeHours !== undefined) {
      this.config.activeHours = config.activeHours;
    }
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
      if (!config.enabled) {
        this.stop();
      } else if (this.started) {
        this.scheduleNext();
      }
    }

    // 重新调度
    if (this.started && this.config.enabled) {
      if (this.state.timer) {
        clearTimeout(this.state.timer);
      }
      this.scheduleNext();
    }
  }

  /**
   * 获取状态信息 (调试用)
   */
  getStatus(): {
    enabled: boolean;
    started: boolean;
    nextDueMs: number;
    lastRunAt: number | null;
    intervalMs: number;
    activeHours?: ActiveHours;
  } {
    return {
      enabled: this.config.enabled,
      started: this.started,
      nextDueMs: this.state.nextDueMs,
      lastRunAt: this.state.lastRunAt,
      intervalMs: this.config.intervalMs,
      activeHours: this.config.activeHours,
    };
  }
}

// ============== 导出类型 ==============

export type { HeartbeatHandler as HeartbeatCallback };
