/**
 * 会话管理器 (Session Manager)
 *
 * 对应 OpenClaw 源码: src/agents/session-manager.ts
 *
 * 核心设计决策:
 *
 * 1. 为什么用 JSONL 而不是单个 JSON 文件？
 *    - JSONL (JSON Lines) 每行一条消息，追加写入
 *    - 优点: 写入是 O(1)，不需要读取整个文件再写回
 *    - 优点: 文件损坏时只影响单行，容错性更好
 *    - 优点: 可以用 tail -f 实时监控
 *    - OpenClaw 也是这样做的
 *
 * 2. 为什么用内存缓存 + 磁盘持久化（双写）？
 *    - 内存缓存: 避免每次 get() 都读磁盘，性能好
 *    - 磁盘持久化: Agent 重启后能恢复上下文
 *    - 写入时同时更新两者，保持一致性
 *
 * 3. 会话 Key 的安全处理
 *    - 用户可能传入恶意 sessionKey (如 "../../../etc/passwd")
 *    - 必须清理为安全的文件名
 */

import fs from "node:fs/promises";
import path from "node:path";

// ============== 类型定义 ==============

/**
 * 消息结构
 * 与 Anthropic API 的 MessageParam 兼容
 */
export interface Message {
  /** 角色: user 或 assistant */
  role: "user" | "assistant";
  /** 内容: 可以是纯文本，也可以是多个内容块（包含工具调用） */
  content: string | ContentBlock[];
  /** 时间戳: 用于排序和调试 */
  timestamp: number;
}

/**
 * 内容块结构
 * 支持文本、工具调用、工具结果三种类型
 */
export interface ContentBlock {
  /** 类型 */
  type: "text" | "tool_use" | "tool_result";
  /** 文本内容 (type=text 时) */
  text?: string;
  /** 工具调用 ID (type=tool_use 时由 API 生成) */
  id?: string;
  /** 工具名称 (type=tool_use 时) */
  name?: string;
  /** 工具输入参数 (type=tool_use 时) */
  input?: Record<string, unknown>;
  /** 关联的工具调用 ID (type=tool_result 时) */
  tool_use_id?: string;
  /** 工具执行结果 (type=tool_result 时) */
  content?: string;
}

// ============== 会话管理器 ==============

export class SessionManager {
  /** 会话文件存储目录 */
  private baseDir: string;

  /**
   * 内存缓存
   * 为什么需要？避免每次 get() 都读磁盘，Agent Loop 中会频繁读取历史
   */
  private cache = new Map<string, Message[]>();

  constructor(baseDir: string = "./.openclaw-mini/sessions") {
    this.baseDir = baseDir;
  }

  /**
   * 获取会话文件路径
   *
   * 安全处理: 使用 encodeURIComponent 编码 sessionKey
   * 防止路径注入攻击 (如 sessionKey = "../../../etc/passwd")
   */
  private getPath(sessionKey: string): string {
    const safeId = encodeURIComponent(sessionKey);
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  private getLegacyPath(sessionKey: string): string {
    const safeId = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(this.baseDir, `${safeId}.jsonl`);
  }

  /**
   * 加载会话历史
   *
   * 优先从内存缓存读取，缓存未命中时从磁盘加载
   * 这是典型的 Cache-Aside 模式
   */
  async load(sessionKey: string): Promise<Message[]> {
    // 1. 检查缓存
    if (this.cache.has(sessionKey)) {
      return this.cache.get(sessionKey)!;
    }

    // 2. 从磁盘加载 JSONL 文件
    const filePath = this.getPath(sessionKey);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const messages = content
        .split("\n")
        .filter((line: string) => line.trim()) // 跳过空行
        .map((line: string) => JSON.parse(line) as Message);

      // 3. 写入缓存
      this.cache.set(sessionKey, messages);
      return messages;
    } catch {
      // 兼容旧命名（下划线替换）
      try {
        const legacyPath = this.getLegacyPath(sessionKey);
        const legacyContent = await fs.readFile(legacyPath, "utf-8");
        const messages = legacyContent
          .split("\n")
          .filter((line: string) => line.trim())
          .map((line: string) => JSON.parse(line) as Message);
        this.cache.set(sessionKey, messages);
        return messages;
      } catch {
        // 文件不存在，返回空数组
        this.cache.set(sessionKey, []);
        return [];
      }
    }
  }

  /**
   * 追加消息
   *
   * 双写策略:
   * 1. 先更新内存缓存（保证后续 get() 能立即读到）
   * 2. 再追加写入磁盘（保证持久化）
   *
   * 为什么用 appendFile 而不是 writeFile？
   * - appendFile 是追加写入，不需要读取整个文件
   * - 写入是 O(1)，无论文件多大
   */
  async append(sessionKey: string, message: Message): Promise<void> {
    // 1. 更新内存缓存
    const messages = this.cache.get(sessionKey) ?? [];
    messages.push(message);
    this.cache.set(sessionKey, messages);

    // 2. 追加写入磁盘
    const filePath = this.getPath(sessionKey);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(message) + "\n");
  }

  /**
   * 获取会话消息 (仅内存)
   * 用于快速读取，不触发磁盘 IO
   */
  get(sessionKey: string): Message[] {
    return this.cache.get(sessionKey) ?? [];
  }

  /**
   * 清空会话
   * 同时清理内存缓存和磁盘文件
   */
  async clear(sessionKey: string): Promise<void> {
    this.cache.delete(sessionKey);
    const filePath = this.getPath(sessionKey);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在，忽略
    }
    try {
      const legacyPath = this.getLegacyPath(sessionKey);
      if (legacyPath !== filePath) {
        await fs.unlink(legacyPath);
      }
    } catch {
      // 旧文件不存在，忽略
    }
  }

  /**
   * 列出所有会话
   * 扫描目录下的 .jsonl 文件
   */
  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.baseDir);
      return files
        .filter((f: string) => f.endsWith(".jsonl"))
        .map((f: string) => decodeURIComponent(f.replace(".jsonl", "")));
    } catch {
      return [];
    }
  }
}
