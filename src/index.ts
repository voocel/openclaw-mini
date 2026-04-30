/**
 * Mini Agent - 极简 AI Agent 框架
 *
 * 模块分层:
 *
 * [核心层] 任何 Agent 都需要的基础能力
 *   - Agent Loop (双层循环 + EventStream)
 *   - Session (会话持久化)
 *   - Context (上下文加载 + 裁剪 + 摘要压缩)
 *   - Tools (工具抽象 + 内置工具)
 *   - Provider (多模型适配)
 *
 * [扩展层] openclaw 特有的高级功能，非通用 Agent 必需
 *   - Memory (长期记忆 - 关键词检索)
 *   - Skills (技能系统 - SKILL.md 触发词匹配)
 *   - Heartbeat (主动唤醒 - 定时/事件驱动)
 *
 * [工程层] 生产级防护与控制，学习可跳过
 *   - Session Key (多 agent 会话键规范化)
 *   - Tool Policy (工具访问三级控制)
 *   - Command Queue (并发 lane 控制)
 *   - Sandbox Paths / Context Window Guard / Tool Result Guard
 */

// =============================================
// [核心层] Core - 任何 Agent 都需要
// =============================================

// Agent 入口 + 运行结果
export { Agent, type AgentConfig, type RunResult } from "./agent.js";

// Agent Loop — 双层循环 (outer=follow-up, inner=tools+steering)
export { runAgentLoop, type AgentLoopParams } from "./agent-loop.js";

// EventStream — 18 种类型化事件，异步推拉模型
export {
  type MiniAgentEvent,
  type MiniAgentResult,
  createMiniAgentStream,
} from "./agent-events.js";

// Session — JSONL 持久化 + 历史管理
export { SessionManager, type Message, type ContentBlock } from "./session.js";

// Context — 按需加载 (AGENTS.md 等) + 裁剪 + 摘要压缩
export { ContextLoader, type ContextFile } from "./context/index.js";

// Tools — 工具抽象 + 内置工具 (read/write/edit/exec/list/grep/memory_save)
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

// Provider — 多模型适配层 (基于 pi-ai，支持 22+ 提供商)
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

// 消息格式转换 (内部消息 → pi-ai 格式)
export { convertMessagesToPi } from "./message-convert.js";

// =============================================
// [扩展层] Extended - openclaw 特有，非通用必需
// =============================================

// Memory — 长期记忆 (关键词检索 + 相关性排序)
export {
  MemoryManager,
  type MemoryEntry,
  type MemorySource,
  type MemorySearchResult,
} from "./memory.js";

// Skills — 技能系统 (SKILL.md frontmatter + 触发词匹配)
export {
  SkillManager,
  type Skill,
  type SkillMatch,
  type SkillEntry,
  type SkillCommandSpec,
  type SkillInvocationPolicy,
} from "./skills.js";

// Heartbeat — 主动唤醒 (两层架构: wake 请求合并 + runner 调度)
export {
  HeartbeatManager,
  type HeartbeatConfig,
  type HeartbeatCallback,
  type HeartbeatResult,
  type HeartbeatHandler,
  type WakeReason,
  type WakeRequest,
  type ActiveHours,
} from "./heartbeat.js";

// =============================================
// [工程层] Production - 生产级防护，学习可跳过
// =============================================

// Session Key — 多 agent 会话键规范化 (agent:agentId:sessionId)
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

// Tool Policy — 工具访问控制 (allow/deny/none 三级编译)
export { type ToolPolicy, filterToolsByPolicy } from "./tool-policy.js";
// Tool Approval — 工具审批 (运行时拦截 + 三级安全 + allowlist)
export {
  type ApprovalSecurity,
  type ApprovalAsk,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalConfig,
  type ApprovalHandler,
  type AllowlistEntry,
  requiresApproval,
  AllowlistManager,
} from "./tool-approval.js";