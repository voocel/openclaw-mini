/**
 * Mini Agent 核心
 *
 * 5 大核心子系统:
 * 1. Session Manager - 会话管理 (JSONL 持久化)
 * 2. Memory Manager - 长期记忆 (关键词搜索)
 * 3. Context Loader - 按需上下文加载 (AGENT.md, HEARTBEAT.md)
 * 4. Skill Manager - 可扩展技能系统
 * 5. Heartbeat Manager - 主动唤醒机制
 *
 * 核心循环:
 *   while (tool_calls) {
 *     response = llm.generate(messages)
 *     for (tool of tool_calls) {
 *       result = tool.execute()
 *       messages.push(result)
 *     }
 *   }
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool, ToolContext } from "./tools/types.js";
import { builtinTools } from "./tools/builtin.js";
import { SessionManager, type Message, type ContentBlock } from "./session.js";
import { MemoryManager, type MemorySearchResult } from "./memory.js";
import { ContextLoader } from "./context.js";
import { SkillManager, type SkillMatch } from "./skills.js";
import { HeartbeatManager, type HeartbeatTask, type WakeRequest, type HeartbeatResult } from "./heartbeat.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  resolveSessionKey,
} from "./session-key.js";
import { enqueueInLane, resolveGlobalLane, resolveSessionLane } from "./command-queue.js";
import { filterToolsByPolicy, mergeToolPolicies, type ToolPolicy } from "./tool-policy.js";

// ============== 类型定义 ==============

export interface AgentConfig {
  /** Anthropic API Key */
  apiKey: string;
  /** 模型 ID */
  model?: string;
  /** Agent ID（默认 main） */
  agentId?: string;
  /** 系统提示 */
  systemPrompt?: string;
  /** 工具列表 */
  tools?: Tool[];
  /** 工具策略（allow/deny） */
  toolPolicy?: ToolPolicy;
  /** 沙箱设置（示意版，仅控制工具可用性） */
  sandbox?: {
    enabled?: boolean;
    allowExec?: boolean;
    allowWrite?: boolean;
  };
  /** 最大循环次数 */
  maxTurns?: number;
  /** 会话存储目录 */
  sessionDir?: string;
  /** 工作目录 */
  workspaceDir?: string;
  /** 记忆存储目录 */
  memoryDir?: string;
  /** 是否启用记忆 */
  enableMemory?: boolean;
  /** 是否启用上下文加载 */
  enableContext?: boolean;
  /** 是否启用技能 */
  enableSkills?: boolean;
  /** 是否启用主动唤醒 */
  enableHeartbeat?: boolean;
  /** Heartbeat 检查间隔 (毫秒) */
  heartbeatInterval?: number;
}

export interface AgentCallbacks {
  /** 流式文本增量 */
  onTextDelta?: (delta: string) => void;
  /** 文本完成 */
  onTextComplete?: (text: string) => void;
  /** 工具调用开始 */
  onToolStart?: (name: string, input: unknown) => void;
  /** 工具调用结束 */
  onToolEnd?: (name: string, result: string) => void;
  /** 轮次开始 */
  onTurnStart?: (turn: number) => void;
  /** 轮次结束 */
  onTurnEnd?: (turn: number) => void;
  /** 技能匹配 */
  onSkillMatch?: (match: SkillMatch) => void;
  /** 记忆检索 */
  onMemorySearch?: (results: MemorySearchResult[]) => void;
  /** Heartbeat 任务触发 */
  onHeartbeat?: (tasks: HeartbeatTask[]) => void;
}

export interface RunResult {
  /** 最终文本 */
  text: string;
  /** 总轮次 */
  turns: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** 是否触发了技能 */
  skillTriggered?: string;
  /** 记忆检索结果数（memory_search 返回的条数） */
  memoriesUsed?: number;
}

// ============== 默认系统提示 ==============

const DEFAULT_SYSTEM_PROMPT = `你是一个编程助手 Agent。

## 可用工具
- read: 读取文件内容
- write: 写入文件
- edit: 编辑文件 (字符串替换)
- exec: 执行 shell 命令
- list: 列出目录
- grep: 搜索文件内容

## 原则
1. 修改代码前必须先读取文件
2. 使用 edit 进行小范围修改
3. 保持简洁，不要过度解释
4. 遇到错误时分析原因并重试

## 输出格式
- 简洁的语言
- 代码使用 markdown 格式`;

// ============== Agent 核心类 ==============

export class Agent {
  private client: Anthropic;
  private model: string;
  private agentId: string;
  private baseSystemPrompt: string;
  private tools: Tool[];
  private maxTurns: number;
  private workspaceDir: string;
  private toolPolicy?: ToolPolicy;
  private sandbox?: {
    enabled: boolean;
    allowExec: boolean;
    allowWrite: boolean;
  };

  // 5 大子系统
  private sessions: SessionManager;
  private memory: MemoryManager;
  private context: ContextLoader;
  private skills: SkillManager;
  private heartbeat: HeartbeatManager;

  // 功能开关
  private enableMemory: boolean;
  private enableContext: boolean;
  private enableSkills: boolean;
  private enableHeartbeat: boolean;

  constructor(config: AgentConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? "claude-sonnet-4-20250514";
    this.agentId = normalizeAgentId(config.agentId ?? "main");
    this.baseSystemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.tools = config.tools ?? builtinTools;
    this.maxTurns = config.maxTurns ?? 20;
    this.workspaceDir = config.workspaceDir ?? process.cwd();
    this.toolPolicy = config.toolPolicy;
    this.sandbox = {
      enabled: config.sandbox?.enabled ?? false,
      allowExec: config.sandbox?.allowExec ?? false,
      allowWrite: config.sandbox?.allowWrite ?? true,
    };

    // 初始化子系统
    this.sessions = new SessionManager(config.sessionDir);
    this.memory = new MemoryManager(config.memoryDir ?? "./.mini-agent/memory");
    this.context = new ContextLoader(this.workspaceDir);
    this.skills = new SkillManager(this.workspaceDir);
    this.heartbeat = new HeartbeatManager(this.workspaceDir, {
      intervalMs: config.heartbeatInterval,
    });

    // 功能开关
    this.enableMemory = config.enableMemory ?? true;
    this.enableContext = config.enableContext ?? true;
    this.enableSkills = config.enableSkills ?? true;
    this.enableHeartbeat = config.enableHeartbeat ?? false; // 默认关闭自动唤醒
  }

  /**
   * 根据策略/沙箱生成最终可用工具集
   */
  private resolveToolsForRun(): Tool[] {
    let tools = [...this.tools];

    if (!this.enableMemory) {
      tools = tools.filter((tool) => tool.name !== "memory_search" && tool.name !== "memory_get");
    }

    const sandboxPolicy = this.buildSandboxToolPolicy();
    const effectivePolicy = mergeToolPolicies(this.toolPolicy, sandboxPolicy);
    return filterToolsByPolicy(tools, effectivePolicy);
  }

  /**
   * 沙箱策略（示意版）
   * - enable=true 且 allowExec=false 时禁用 exec
   * - allowWrite=false 时禁用 write/edit
   */
  private buildSandboxToolPolicy(): ToolPolicy | undefined {
    if (!this.sandbox?.enabled) {
      return undefined;
    }
    const deny: string[] = [];
    if (!this.sandbox.allowExec) {
      deny.push("exec");
    }
    if (!this.sandbox.allowWrite) {
      deny.push("write", "edit");
    }
    return deny.length > 0 ? { deny } : undefined;
  }

  /**
   * 构建完整系统提示
   */
  private async buildSystemPrompt(): Promise<string> {
    let prompt = this.baseSystemPrompt;
    const availableTools = new Set(this.resolveToolsForRun().map((t) => t.name));

    // 注入上下文
    if (this.enableContext) {
      const contextPrompt = await this.context.buildContextPrompt();
      if (contextPrompt) {
        prompt += contextPrompt;
      }
    }

    // 注入技能描述
    if (this.enableSkills) {
      const skillsPrompt = await this.skills.buildSkillsPrompt();
      if (skillsPrompt) {
        prompt += skillsPrompt;
      }
    }

    // 注入记忆使用指引（工具化）
    if (this.enableMemory && (availableTools.has("memory_search") || availableTools.has("memory_get"))) {
      prompt += `\n\n## 记忆\n在回答涉及历史、偏好、决定、待办时：先用 memory_search 查找，再用 memory_get 拉取必要细节。不要臆测。`;
    }

    // 注入沙箱约束说明
    if (this.sandbox?.enabled) {
      const writeHint = this.sandbox.allowWrite ? "可写" : "只读";
      const execHint = this.sandbox.allowExec ? "允许" : "禁止";
      prompt += `\n\n## 沙箱\n当前为沙箱模式：工作区${writeHint}，命令执行${execHint}。`;
    }

    return prompt;
  }

  /**
   * 运行 Agent
   */
  async run(
    sessionIdOrKey: string,
    userMessage: string,
    callbacks?: AgentCallbacks,
  ): Promise<RunResult> {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    const sessionLane = resolveSessionLane(sessionKey);
    const globalLane = resolveGlobalLane();

    return enqueueInLane(sessionLane, () =>
      enqueueInLane(globalLane, async () => {
        // 加载历史
        const history = await this.sessions.load(sessionKey);

        let memoriesUsed = 0;
        const toolCtx: ToolContext = {
          workspaceDir: this.workspaceDir,
          sessionKey,
          sessionId: sessionIdOrKey,
          agentId: resolveAgentIdFromSessionKey(sessionKey),
          memory: this.enableMemory ? this.memory : undefined,
          onMemorySearch: (results) => {
            memoriesUsed += results.length;
            callbacks?.onMemorySearch?.(results);
          },
        };

        let processedMessage = userMessage;
        let skillTriggered: string | undefined;

        // ===== 技能匹配 =====
        if (this.enableSkills) {
          const match = await this.skills.match(userMessage);
          if (match) {
            callbacks?.onSkillMatch?.(match);
            skillTriggered = match.skill.id;
            // 将技能 prompt 注入消息
            const trigger = match.matchedTrigger || "";
            const userPart = userMessage.slice(trigger.length).trim() || userMessage;
            processedMessage = `${match.skill.prompt}\n\n用户请求: ${userPart}`;
          }
        }

        // 记忆检索改为工具化调用，不在此自动注入

        // ===== Heartbeat 任务注入 =====
        if (this.enableHeartbeat) {
          const tasksPrompt = await this.heartbeat.buildTasksPrompt();
          if (tasksPrompt) {
            processedMessage += tasksPrompt;
          }
        }

        // 添加用户消息
        const userMsg: Message = {
          role: "user",
          content: processedMessage,
          timestamp: Date.now(),
        };
        await this.sessions.append(sessionKey, userMsg);

        let turns = 0;
        let totalToolCalls = 0;
        let finalText = "";
        const currentMessages = [...history, userMsg];

        // 构建系统提示
        const systemPrompt = await this.buildSystemPrompt();
        const toolsForRun = this.resolveToolsForRun();

        // ===== Agent Loop =====
        while (turns < this.maxTurns) {
          turns++;
          callbacks?.onTurnStart?.(turns);

          // 调用 LLM (流式)
          const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 4096,
            system: systemPrompt,
            tools: toolsForRun.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
            messages: currentMessages.map((m) => ({
              role: m.role,
              content: m.content,
            })) as Anthropic.MessageParam[],
          });

          // 处理流式响应
          for await (const event of stream) {
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                callbacks?.onTextDelta?.(event.delta.text);
              }
            }
          }

          // 获取完整响应
          const response = await stream.finalMessage();

          // 解析响应
          const assistantContent: ContentBlock[] = [];
          const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];

          for (const block of response.content) {
            if (block.type === "text") {
              finalText = block.text;
              callbacks?.onTextComplete?.(block.text);
              assistantContent.push({ type: "text", text: block.text });
            } else if (block.type === "tool_use") {
              callbacks?.onToolStart?.(block.name, block.input);
              assistantContent.push({
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              });
              toolCalls.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              });
            }
          }

          // 保存 assistant 消息
          const assistantMsg: Message = {
            role: "assistant",
            content: assistantContent,
            timestamp: Date.now(),
          };
          await this.sessions.append(sessionKey, assistantMsg);
          currentMessages.push(assistantMsg);

          callbacks?.onTurnEnd?.(turns);

          // 没有工具调用，结束
          if (toolCalls.length === 0) {
            break;
          }

          // 执行工具
          totalToolCalls += toolCalls.length;
          const toolResults: ContentBlock[] = [];

          for (const call of toolCalls) {
            const tool = toolsForRun.find((t) => t.name === call.name);
            let result: string;

            if (tool) {
              try {
                result = await tool.execute(call.input, toolCtx);
              } catch (err) {
                result = `执行错误: ${(err as Error).message}`;
              }
            } else {
              result = `未知工具: ${call.name}`;
            }

            callbacks?.onToolEnd?.(call.name, result);
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: result,
            });
          }

          // 添加工具结果
          const resultMsg: Message = {
            role: "user",
            content: toolResults,
            timestamp: Date.now(),
          };
          await this.sessions.append(sessionKey, resultMsg);
          currentMessages.push(resultMsg);
        }

        // ===== 保存到记忆 =====
        if (this.enableMemory && finalText) {
          await this.memory.add(
            `Q: ${userMessage}\nA: ${finalText.slice(0, 500)}`,
            "agent",
            [sessionKey],
          );
        }

        return {
          text: finalText,
          turns,
          toolCalls: totalToolCalls,
          skillTriggered,
          memoriesUsed,
        };
      }),
    );
  }

  /**
   * 启动 Heartbeat 监控
   */
  startHeartbeat(callback?: (tasks: HeartbeatTask[], request: WakeRequest) => void): void {
    if (callback) {
      this.heartbeat.onTasks(async (tasks, request): Promise<HeartbeatResult> => {
        callback(tasks, request);
        return { status: "ok", tasks };
      });
    }
    this.heartbeat.start();
  }

  /**
   * 停止 Heartbeat 监控
   */
  stopHeartbeat(): void {
    this.heartbeat.stop();
  }

  /**
   * 手动触发 Heartbeat 检查
   */
  async triggerHeartbeat(): Promise<HeartbeatTask[]> {
    return this.heartbeat.trigger();
  }

  /**
   * 重置会话
   */
  async reset(sessionIdOrKey: string): Promise<void> {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    await this.sessions.clear(sessionKey);
  }

  /**
   * 获取会话历史
   */
  getHistory(sessionIdOrKey: string): Message[] {
    const sessionKey = resolveSessionKey({
      agentId: this.agentId,
      sessionId: sessionIdOrKey,
      sessionKey: sessionIdOrKey,
    });
    return this.sessions.get(sessionKey);
  }

  /**
   * 列出会话
   */
  async listSessions(): Promise<string[]> {
    return this.sessions.list();
  }

  // ===== 子系统访问器 =====

  getMemory(): MemoryManager {
    return this.memory;
  }

  getContext(): ContextLoader {
    return this.context;
  }

  getSkills(): SkillManager {
    return this.skills;
  }

  getHeartbeat(): HeartbeatManager {
    return this.heartbeat;
  }
}
