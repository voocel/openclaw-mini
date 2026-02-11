/**
 * Mini Agent - 极简 AI Agent 框架
 *
 * 5 大核心子系统:
 * 1. Session Manager - 会话管理 (JSONL 持久化)
 * 2. Memory Manager - 长期记忆 (关键词搜索)
 * 3. Context Loader - 按需上下文加载 (AGENT.md, HEARTBEAT.md)
 * 4. Skill Manager - 可扩展技能系统
 * 5. Heartbeat Manager - 主动唤醒机制
 */

// Agent 核心
export { Agent, type AgentConfig, type AgentCallbacks, type RunResult } from "./agent.js";

// Agent Loop
export { runAgentLoop, type AgentLoopParams, type AgentLoopCallbacks, type AgentLoopResult } from "./agent-loop.js";

// 消息格式转换
export { convertMessagesToPi } from "./message-convert.js";

// 事件流
export {
  type AgentEventStream,
  type AgentEventPayload,
  emitAgentEvent,
  onAgentEvent,
} from "./agent-events.js";

// 会话管理
export { SessionManager, type Message, type ContentBlock } from "./session.js";

// Session Key
export {
  DEFAULT_AGENT_ID,
  DEFAULT_MAIN_KEY,
  normalizeAgentId,
  resolveSessionKey,
  parseAgentSessionKey,
  isSubagentSessionKey,
  buildAgentMainSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.js";

// Tool Policy
export { type ToolPolicy, filterToolsByPolicy } from "./tool-policy.js";

// 长期记忆
export {
  MemoryManager,
  type MemoryEntry,
  type MemorySearchResult,
} from "./memory.js";

// 上下文加载
export { ContextLoader, type ContextFile } from "./context/index.js";

// 技能系统
export {
  SkillManager,
  type Skill,
  type SkillMatch,
  type SkillEntry,
  type SkillCommandSpec,
  type SkillInvocationPolicy,
} from "./skills.js";

// 主动唤醒
export {
  HeartbeatManager,
  type HeartbeatTask,
  type HeartbeatConfig,
  type HeartbeatCallback,
  type HeartbeatResult,
  type HeartbeatHandler,
  type WakeReason,
  type WakeRequest,
  type ActiveHours,
} from "./heartbeat.js";

// 工具
export {
  type Tool,
  type ToolContext,
  type ToolCall,
  type ToolResult,
  builtinTools,
  readTool,
  writeTool,
  editTool,
  execTool,
  listTool,
  grepTool,
  memorySaveTool,
} from "./tools/index.js";

// Provider 抽象层（基于 @mariozechner/pi-ai）
export {
  type Api,
  type Provider,
  type Model,
  type StreamFunction,
  type StreamOptions,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type ThinkingLevel,
  type StopReason,
  stream,
  streamSimple,
  streamAnthropic,
  getModel,
  getModels,
  isContextOverflow,
  createAssistantMessageEventStream,
  FailoverError,
  isFailoverError,
  type FailoverReason,
  type RetryOptions,
  retryAsync,
  isContextOverflowError,
  classifyFailoverReason,
  describeError,
} from "./provider/index.js";
