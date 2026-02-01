/**
 * 工具系统类型定义
 *
 * 对应 OpenClaw 源码: src/tools/ 目录
 *
 * 核心设计:
 *
 * 1. 什么是"工具"？
 *    - 工具是 Agent 与外部世界交互的接口
 *    - LLM 本身只能生成文本，通过工具可以读写文件、执行命令等
 *    - Anthropic 称之为 "Tool Use"，OpenAI 称之为 "Function Calling"
 *
 * 2. 为什么用 JSON Schema 定义工具输入？
 *    - JSON Schema 是标准格式，LLM 能理解并生成符合 schema 的参数
 *    - Anthropic API 要求 inputSchema 必须是 JSON Schema 格式
 *    - 这样 LLM 知道每个参数的类型、是否必填、描述等
 *
 * 3. 工具执行流程:
 *    ```
 *    User: "读取 src/index.ts 文件"
 *         ↓
 *    LLM 返回: { tool_use: { name: "read", input: { file_path: "src/index.ts" } } }
 *         ↓
 *    Agent 执行: readTool.execute({ file_path: "src/index.ts" }, ctx)
 *         ↓
 *    Agent 返回: { tool_result: { content: "文件内容..." } }
 *         ↓
 *    LLM 继续生成最终回复
 *    ```
 */

import type { MemoryManager, MemorySearchResult } from "../memory.js";

// ============== 执行上下文 ==============

/**
 * 工具执行上下文
 *
 * 每次工具执行时传入，提供运行时信息
 */
export interface ToolContext {
  /** 工作目录: 文件操作的基准路径，防止访问工作区外的文件 */
  workspaceDir: string;
  /** 会话 Key: 用于隔离不同 agent / 会话的状态 */
  sessionKey: string;
  /** 兼容字段：保留 sessionId（便于 CLI/调试显示） */
  sessionId?: string;
  /** 当前 agentId（用于策略或日志） */
  agentId?: string;
  /** 记忆管理器（启用记忆工具时注入） */
  memory?: MemoryManager;
  /** 记忆检索回调（用于统计或可视化） */
  onMemorySearch?: (results: MemorySearchResult[]) => void;
  /** 中止信号: 支持取消长时间运行的操作 */
  abortSignal?: AbortSignal;
}

// ============== 工具定义 ==============

/**
 * 工具接口
 *
 * 泛型 TInput 用于类型安全的参数定义
 * 实际使用时会被擦除，但开发时有类型提示
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TInput = any> {
  /** 工具名称: LLM 用这个名字来调用工具 */
  name: string;

  /** 工具描述: 告诉 LLM 这个工具做什么、什么时候用 */
  description: string;

  /**
   * 输入参数的 JSON Schema
   *
   * 格式要求 (Anthropic API):
   * - type 必须是 "object"
   * - properties 定义每个参数的 schema
   * - required 列出必填参数
   *
   * 示例:
   * ```
   * {
   *   type: "object",
   *   properties: {
   *     file_path: { type: "string", description: "文件路径" },
   *     limit: { type: "number", description: "最大行数" }
   *   },
   *   required: ["file_path"]
   * }
   * ```
   */
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * 执行函数
   *
   * @param input - LLM 生成的参数，已经过 JSON 解析
   * @param ctx - 执行上下文
   * @returns 执行结果字符串，会返回给 LLM
   */
  execute: (input: TInput, ctx: ToolContext) => Promise<string>;
}

// ============== 工具调用记录 ==============

/**
 * 工具调用记录
 * LLM 返回的 tool_use 块解析后的结构
 */
export interface ToolCall {
  /** 调用 ID: 由 API 生成，用于关联 tool_result */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  input: Record<string, unknown>;
}

/**
 * 工具执行结果
 * 返回给 LLM 的 tool_result 块
 */
export interface ToolResult {
  /** 关联的工具调用 ID */
  toolUseId: string;
  /** 执行结果内容 */
  content: string;
  /** 是否是错误 */
  isError?: boolean;
}
