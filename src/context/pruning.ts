/**
 * 上下文修剪 (Context Pruning)
 *
 * 对应 OpenClaw 源码:
 * - src/agents/pi-extensions/context-pruning/pruner.ts — 工具结果内容修剪
 * - src/agents/pi-extensions/context-pruning/settings.ts — 修剪配置
 * - src/agents/pi-extensions/context-pruning/tools.ts — 工具可修剪性判定
 * - src/agents/compaction.ts — 消息级丢弃 (pruneHistoryForContextShare)
 *
 * 三层递进修剪策略 (与 openclaw 对齐):
 *
 * Layer 1: Soft Trim (工具结果内容截断)
 *   触发: 比例超过 softTrimRatio (默认 0.3)
 *   操作: 对可修剪工具的结果保留 head + tail，丢弃中间
 *   对应: pruner.ts softTrimToolResultMessage()
 *
 * Layer 2: Hard Clear (工具结果内容清空)
 *   触发: soft trim 后比例仍超过 hardClearRatio (默认 0.5)
 *   前提: 可修剪工具结果总字符数 > minPrunableToolChars
 *   操作: 用占位符替换工具结果内容 "[Old tool result content cleared]"
 *   对应: pruner.ts 的 hard clear 逻辑
 *
 * Layer 3: Message Drop (消息级丢弃)
 *   触发: 总字符超过 history budget
 *   操作: 从旧到新丢弃整条消息，保护最近 N 条 assistant
 *   对应: compaction.ts pruneHistoryForContextShare()
 */

import type { ContentBlock, Message } from "../session.js";
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateMessageChars,
  estimateMessagesChars,
} from "./tokens.js";

// ============== 工具可修剪性判定 (对应 pruner/tools.ts) ==============

/**
 * 工具修剪规则
 *
 * 对应 OpenClaw: ContextPruningToolMatch
 * allow 为空时所有非 deny 工具都可修剪
 */
export type ContextPruningToolMatch = {
  /** 白名单（glob 风格，如 ["exec", "file_*"]）。空数组 = 全部可修剪 */
  allow?: string[];
  /** 黑名单（优先级高于 allow） */
  deny?: string[];
};

/**
 * 构建工具可修剪性谓词
 *
 * 对应 OpenClaw: makeToolPrunablePredicate()
 * 逻辑: deny 优先 → allow 空则全允许 → 否则匹配 allow
 */
function makeToolPrunablePredicate(
  match?: ContextPruningToolMatch,
): (toolName: string) => boolean {
  if (!match) return () => true;

  const deny = match.deny ?? [];
  const allow = match.allow ?? [];

  return (toolName: string) => {
    const normalized = toolName.trim().toLowerCase();
    if (deny.some((pattern) => matchGlob(normalized, pattern.toLowerCase()))) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return allow.some((pattern) => matchGlob(normalized, pattern.toLowerCase()));
  };
}

/** 简易 glob 匹配 (仅支持 * 通配符) */
function matchGlob(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;
  const regex = new RegExp(
    `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`))}$`,
  );
  return regex.test(value);
}

// ============== 配置 ==============

export type ContextPruningSettings = {
  /** 历史消息占上下文窗口的最大比例 (消息级丢弃预算) */
  maxHistoryShare: number;
  /** 保护最近 N 条 assistant 消息不被丢弃 */
  keepLastAssistants: number;
  /** 触发 soft trim 的比例阈值 (对应 openclaw softTrimRatio) */
  softTrimRatio: number;
  /** 触发 hard clear 的比例阈值 (对应 openclaw hardClearRatio) */
  hardClearRatio: number;
  /** Hard clear 最低可修剪字符数 (对应 openclaw minPrunableToolChars) */
  minPrunableToolChars: number;
  /** Soft trim 参数 */
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  /** Hard clear 参数 */
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
  /** 工具可修剪规则 */
  tools: ContextPruningToolMatch;
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: ContextPruningSettings = {
  maxHistoryShare: 0.5,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
  tools: {},
};

export type PruneResult = {
  messages: Message[];
  droppedMessages: Message[];
  trimmedToolResults: number;
  hardClearedToolResults: number;
  totalChars: number;
  keptChars: number;
  droppedChars: number;
  budgetChars: number;
};

function clampShare(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

export function resolvePruningSettings(
  raw?: Partial<ContextPruningSettings>,
): ContextPruningSettings {
  if (!raw) return DEFAULT_CONTEXT_PRUNING_SETTINGS;
  const d = DEFAULT_CONTEXT_PRUNING_SETTINGS;
  return {
    maxHistoryShare: clampShare(raw.maxHistoryShare ?? d.maxHistoryShare, d.maxHistoryShare),
    keepLastAssistants: clampPositiveInt(raw.keepLastAssistants, d.keepLastAssistants),
    softTrimRatio: clampShare(raw.softTrimRatio ?? d.softTrimRatio, d.softTrimRatio),
    hardClearRatio: clampShare(raw.hardClearRatio ?? d.hardClearRatio, d.hardClearRatio),
    minPrunableToolChars: clampPositiveInt(raw.minPrunableToolChars, d.minPrunableToolChars),
    softTrim: {
      maxChars: clampPositiveInt(raw.softTrim?.maxChars, d.softTrim.maxChars),
      headChars: clampPositiveInt(raw.softTrim?.headChars, d.softTrim.headChars),
      tailChars: clampPositiveInt(raw.softTrim?.tailChars, d.softTrim.tailChars),
    },
    hardClear: {
      enabled: raw.hardClear?.enabled ?? d.hardClear.enabled,
      placeholder: raw.hardClear?.placeholder ?? d.hardClear.placeholder,
    },
    tools: raw.tools ?? d.tools,
  };
}

// ============== Layer 1: Soft Trim (对应 pruner.ts softTrimToolResultMessage) ==============

function cloneMessage(message: Message, content: Message["content"]): Message {
  return { ...message, content };
}

/**
 * 判断 tool_result block 是否包含不可修剪内容
 *
 * 对应 OpenClaw: 图片等 tool result 不可修剪
 * Mini 的 ContentBlock 暂不支持 image 类型，预留此检查
 */
function isToolResultProtected(_block: ContentBlock): boolean {
  // Mini 的 ContentBlock 只有 text/tool_use/tool_result
  // openclaw 还检查 image 类型，此处预留扩展点
  return false;
}

/**
 * 对单个 tool_result block 执行 soft trim
 *
 * 对应 OpenClaw pruner.ts: softTrimToolResultMessage()
 * 保留 head + tail，丢弃中间，添加说明
 */
function softTrimToolResultBlock(
  block: ContentBlock,
  settings: ContextPruningSettings["softTrim"],
  isPrunable: (toolName: string) => boolean,
): { block: ContentBlock; trimmed: boolean } {
  if (block.type !== "tool_result") {
    return { block, trimmed: false };
  }

  // 受保护的 tool result 不修剪
  if (isToolResultProtected(block)) {
    return { block, trimmed: false };
  }

  // 工具可修剪性检查（用工具名，不是 tool_use_id）
  if (block.name && !isPrunable(block.name)) {
    return { block, trimmed: false };
  }

  const raw = typeof block.content === "string" ? block.content : "";
  const rawLen = raw.length;
  if (rawLen <= settings.maxChars) {
    return { block, trimmed: false };
  }

  const headChars = Math.max(0, settings.headChars);
  const tailChars = Math.max(0, settings.tailChars);
  if (headChars + tailChars >= rawLen) {
    return { block, trimmed: false };
  }

  const head = raw.slice(0, headChars);
  const tail = raw.slice(rawLen - tailChars);
  const trimmedText =
    `${head}\n...\n${tail}\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return {
    block: { ...block, content: trimmedText },
    trimmed: true,
  };
}

function applySoftTrim(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
): { messages: Message[]; trimmedToolResults: number } {
  let trimmedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      const result = softTrimToolResultBlock(block, settings.softTrim, isPrunable);
      if (result.trimmed) {
        trimmedToolResults += 1;
        didChange = true;
      }
      nextBlocks.push(result.block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, trimmedToolResults };
}

// ============== Layer 2: Hard Clear (对应 pruner.ts hard clear 逻辑) ==============

/**
 * 计算可修剪工具结果的总字符数
 */
function countPrunableToolChars(
  messages: Message[],
  isPrunable: (toolName: string) => boolean,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      if (isToolResultProtected(block)) continue;
      if (block.name && !isPrunable(block.name)) continue;
      const text = typeof block.content === "string" ? block.content : "";
      total += text.length;
    }
  }
  return total;
}

/**
 * 对可修剪工具结果执行 hard clear
 *
 * 对应 OpenClaw pruner.ts: hard clear 阶段
 * 用占位符替换内容，保留消息结构和 toolCallId（便于调试追溯）
 */
function applyHardClear(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
  charWindow: number,
): { messages: Message[]; hardClearedToolResults: number } {
  if (!settings.hardClear.enabled) {
    return { messages, hardClearedToolResults: 0 };
  }

  let totalChars = estimateMessagesChars(messages);
  const ratio = totalChars / charWindow;

  // 仅在超过 hardClearRatio 时触发
  if (ratio < settings.hardClearRatio) {
    return { messages, hardClearedToolResults: 0 };
  }

  // 可修剪字符数不足时不触发
  const prunableChars = countPrunableToolChars(messages, isPrunable);
  if (prunableChars < settings.minPrunableToolChars) {
    return { messages, hardClearedToolResults: 0 };
  }

  let hardClearedToolResults = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];

    for (const block of msg.content) {
      // 仅 clear 可修剪的 tool_result（非图片）
      if (
        block.type === "tool_result" &&
        !isToolResultProtected(block) &&
        typeof block.content === "string" &&
        block.content.length > 0
      ) {
        const canPrune = !block.name || isPrunable(block.name);

        if (canPrune) {
          // 比例已降到阈值以下时停止
          const currentRatio = totalChars / charWindow;
          if (currentRatio < settings.hardClearRatio) {
            nextBlocks.push(block);
            continue;
          }

          const beforeLen = block.content.length;
          const clearedBlock: ContentBlock = {
            ...block,
            content: settings.hardClear.placeholder,
          };
          nextBlocks.push(clearedBlock);
          totalChars -= beforeLen - settings.hardClear.placeholder.length;
          hardClearedToolResults += 1;
          didChange = true;
          continue;
        }
      }

      nextBlocks.push(block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, hardClearedToolResults };
}

// ============== Layer 3: Message Drop (对应 compaction.ts pruneHistoryForContextShare) ==============

/**
 * 查找 assistant cutoff 保护边界
 *
 * 对应 OpenClaw: keepLastAssistants 保护机制
 * 从后往前数，保护最近 N 条 assistant 消息及其之后的所有消息
 */
function findAssistantCutoffIndex(messages: Message[], keepLastAssistants: number): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "assistant") continue;
    remaining -= 1;
    if (remaining === 0) return i;
  }
  return null;
}

/**
 * 从后往前填充预算
 *
 * 保留尽可能多的最近消息，直到超出 budget
 */
function sliceWithinBudget(messages: Message[], budgetChars: number): Message[] {
  const kept: Message[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = estimateMessageChars(msg);
    if (used + chars > budgetChars && kept.length > 0) break;
    kept.push(msg);
    used += chars;
  }
  kept.reverse();
  return kept;
}

// ============== 主入口 ==============

/**
 * 三层递进上下文修剪
 *
 * 对应 OpenClaw pruner.ts: pruneContextMessages()
 * 执行顺序: soft trim → hard clear → message drop
 */
export function pruneContextMessages(params: {
  messages: Message[];
  contextWindowTokens: number;
  settings?: Partial<ContextPruningSettings>;
}): PruneResult {
  const settings = resolvePruningSettings(params.settings);
  const contextTokens = Math.max(1, Math.floor(params.contextWindowTokens));
  const charWindow = contextTokens * CHARS_PER_TOKEN_ESTIMATE;
  const budgetChars = Math.max(1, Math.floor(charWindow * settings.maxHistoryShare));
  const isPrunable = makeToolPrunablePredicate(settings.tools);

  let current = params.messages;
  let trimmedToolResults = 0;
  let hardClearedToolResults = 0;

  // Layer 1: Soft Trim — 比例超过 softTrimRatio 时触发
  const totalChars = estimateMessagesChars(current);
  const ratio = totalChars / charWindow;
  if (ratio > settings.softTrimRatio) {
    const trimResult = applySoftTrim(current, settings, isPrunable);
    current = trimResult.messages;
    trimmedToolResults = trimResult.trimmedToolResults;
  }

  // Layer 2: Hard Clear — soft trim 后仍超标时触发
  const afterSoftTrimChars = estimateMessagesChars(current);
  const afterSoftTrimRatio = afterSoftTrimChars / charWindow;
  if (afterSoftTrimRatio > settings.hardClearRatio) {
    const clearResult = applyHardClear(current, settings, isPrunable, charWindow);
    current = clearResult.messages;
    hardClearedToolResults = clearResult.hardClearedToolResults;
  }

  // Layer 3: Message Drop — 超出 history budget 时丢弃旧消息
  const afterClearChars = estimateMessagesChars(current);
  if (afterClearChars <= budgetChars) {
    return {
      messages: current,
      droppedMessages: [],
      trimmedToolResults,
      hardClearedToolResults,
      totalChars: afterClearChars,
      keptChars: afterClearChars,
      droppedChars: 0,
      budgetChars,
    };
  }

  const cutoffIndex = findAssistantCutoffIndex(current, settings.keepLastAssistants);
  const protectedIndex = cutoffIndex ?? 0;
  const protectedMessages = current.slice(protectedIndex);
  const protectedChars = estimateMessagesChars(protectedMessages);

  let kept: Message[];
  if (protectedChars > budgetChars) {
    kept = sliceWithinBudget(current, budgetChars);
  } else {
    kept = [...protectedMessages];
    let remaining = budgetChars - protectedChars;
    for (let i = protectedIndex - 1; i >= 0; i--) {
      const msg = current[i];
      const msgChars = estimateMessageChars(msg);
      if (msgChars > remaining) break;
      kept.unshift(msg);
      remaining -= msgChars;
    }
  }

  const keptSet = new Set(kept);
  const droppedMessages = current.filter((msg) => !keptSet.has(msg));
  const keptChars = estimateMessagesChars(kept);
  const droppedChars = Math.max(0, afterClearChars - keptChars);

  return {
    messages: kept,
    droppedMessages,
    trimmedToolResults,
    hardClearedToolResults,
    totalChars: afterClearChars,
    keptChars,
    droppedChars,
    budgetChars,
  };
}
