/**
 * Agent 主循环
 *
 * 对应 OpenClaw: pi-embedded-runner/run/attempt.ts — 主循环部分
 *
 * 从 Agent 类中提取的纯函数: 接收所有依赖，不访问 Agent 实例状态。
 * 职责:
 * - 每轮 prune → LLM 流式调用 → 工具串行执行
 * - Context overflow → auto-compact → 重试
 * - Steering 中断检测
 */

import type { Tool, ToolContext } from "./tools/types.js";
import type { Message, ContentBlock } from "./session.js";
import type {
  Model,
  StreamFunction,
  SimpleStreamOptions,
  Context as PiContext,
} from "@mariozechner/pi-ai";
import {
  retryAsync,
  isContextOverflowError,
  isRateLimitError,
  describeError,
} from "./provider/errors.js";
import { pruneContextMessages } from "./context/index.js";
import { emitAgentEvent } from "./agent-events.js";
import { abortable } from "./tools/abort.js";
import { convertMessagesToPi } from "./message-convert.js";

// ============== 类型定义 ==============

export interface AgentLoopParams {
  runId: string;
  sessionKey: string;
  agentId: string;
  /** 可变: 循环中会 push 新消息 */
  currentMessages: Message[];
  compactionSummary: Message | undefined;
  systemPrompt: string;
  toolsForRun: Tool[];
  toolCtx: ToolContext;
  modelDef: Model<any>;
  streamFn: StreamFunction;
  apiKey?: string;
  temperature?: number;
  maxTurns: number;
  contextTokens: number;
  steeringQueues: Map<string, string[]>;
  /** 回调 */
  callbacks?: AgentLoopCallbacks;
  /** 持久化 */
  appendMessage: (sessionKey: string, msg: Message) => Promise<void>;
  /** Compaction 触发器 */
  prepareCompaction: (params: {
    messages: Message[];
    sessionKey: string;
    runId: string;
  }) => Promise<{
    summary?: string;
    summaryMessage?: Message;
  }>;
  /** 外部 abort 信号 */
  abortSignal: AbortSignal;
}

export interface AgentLoopCallbacks {
  onTextDelta?: (delta: string) => void;
  onTextComplete?: (text: string) => void;
  onToolStart?: (name: string, input: unknown) => void;
  onToolEnd?: (name: string, result: string) => void;
  onTurnStart?: (turn: number) => void;
  onTurnEnd?: (turn: number) => void;
}

export interface AgentLoopResult {
  finalText: string;
  turns: number;
  totalToolCalls: number;
}

// ============== 主循环 ==============

export async function runAgentLoop(params: AgentLoopParams): Promise<AgentLoopResult> {
  const {
    runId,
    sessionKey,
    agentId,
    currentMessages,
    systemPrompt,
    toolsForRun,
    toolCtx,
    modelDef,
    streamFn,
    apiKey,
    temperature,
    maxTurns,
    contextTokens,
    steeringQueues,
    callbacks,
    appendMessage,
    prepareCompaction,
    abortSignal,
  } = params;

  let { compactionSummary } = params;
  let turns = 0;
  let totalToolCalls = 0;
  let finalText = "";
  let overflowCompactionAttempted = false;

  while (turns < maxTurns) {
    turns++;
    callbacks?.onTurnStart?.(turns);

    // ===== Prune: 每轮都执行 =====
    const pruneResult = pruneContextMessages({
      messages: currentMessages,
      contextWindowTokens: contextTokens,
    });
    let messagesForModel = pruneResult.messages;
    if (compactionSummary) {
      messagesForModel = [compactionSummary, ...messagesForModel];
    }

    // abort 检查
    if (abortSignal.aborted) break;

    // 构造 pi-ai Context
    const piContext: PiContext = {
      systemPrompt,
      messages: convertMessagesToPi(messagesForModel, modelDef),
      tools: toolsForRun.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as any,
      })),
    };

    // ===== 带重试的 LLM 调用 =====
    const assistantContent: ContentBlock[] = [];
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = [];
    const turnTextParts: string[] = [];

    try {
      await retryAsync(
        async () => {
          assistantContent.length = 0;
          toolCalls.length = 0;
          turnTextParts.length = 0;

          const streamOpts: SimpleStreamOptions = {
            maxTokens: modelDef.maxTokens,
            signal: abortSignal,
            apiKey,
            ...(temperature !== undefined ? { temperature } : {}),
          };
          const eventStream = streamFn(modelDef, piContext, streamOpts);

          for await (const event of eventStream) {
            if (abortSignal.aborted) break;

            switch (event.type) {
              case "text_delta":
                callbacks?.onTextDelta?.(event.delta);
                emitAgentEvent({
                  runId,
                  stream: "assistant",
                  sessionKey,
                  agentId,
                  data: { delta: event.delta },
                });
                break;

              case "text_end":
                turnTextParts.push(event.content);
                assistantContent.push({ type: "text", text: event.content });
                break;

              case "toolcall_start":
                break;

              case "toolcall_end": {
                const tc = event.toolCall;
                const tcArgs = tc.arguments as Record<string, unknown>;
                callbacks?.onToolStart?.(tc.name, tcArgs);
                emitAgentEvent({
                  runId,
                  stream: "tool",
                  sessionKey,
                  agentId,
                  data: { phase: "start", name: tc.name, input: tcArgs },
                });
                assistantContent.push({
                  type: "tool_use",
                  id: tc.id,
                  name: tc.name,
                  input: tcArgs,
                });
                toolCalls.push({
                  id: tc.id,
                  name: tc.name,
                  input: tcArgs,
                });
                break;
              }
            }
          }

          // 等待流完成（确保本轮 stream settle 后才可能进入重试）
          const result = eventStream.result();
          await abortable(result, abortSignal);
        },
        {
          attempts: 3,
          minDelayMs: 300,
          maxDelayMs: 30_000,
          jitter: 0.1,
          label: "llm-call",
          shouldRetry: (err) => {
            if (abortSignal.aborted) return false;
            return isRateLimitError(describeError(err));
          },
          onRetry: ({ attempt, delay, error }) => {
            emitAgentEvent({
              runId,
              stream: "lifecycle",
              sessionKey,
              agentId,
              data: { phase: "retry", attempt, delay, error: describeError(error) },
            });
          },
        },
      );
    } catch (llmError) {
      // Context overflow → auto-compact → 重试一次
      const errorText = describeError(llmError);
      if (isContextOverflowError(errorText) && !overflowCompactionAttempted) {
        overflowCompactionAttempted = true;
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          sessionKey,
          agentId,
          data: { phase: "context_overflow_compact", error: errorText },
        });
        const overflowPrep = await prepareCompaction({
          messages: currentMessages,
          sessionKey,
          runId,
        });
        if (overflowPrep.summary && overflowPrep.summaryMessage) {
          compactionSummary = overflowPrep.summaryMessage;
          turns--;
          continue;
        }
      }
      throw llmError;
    }

    // 保存 assistant 消息
    const assistantMsg: Message = {
      role: "assistant",
      content: assistantContent,
      timestamp: Date.now(),
    };
    await appendMessage(sessionKey, assistantMsg);
    currentMessages.push(assistantMsg);

    callbacks?.onTurnEnd?.(turns);

    const turnText = turnTextParts.join("");
    if (turnText) {
      callbacks?.onTextComplete?.(turnText);
      emitAgentEvent({
        runId,
        stream: "assistant",
        sessionKey,
        agentId,
        data: { text: turnText, final: true },
      });
    }

    // 没有工具调用 → 结束
    if (toolCalls.length === 0) {
      finalText = turnText;
      break;
    }

    // ===== 执行工具（串行 + steering 中断检测） =====
    const toolResults: ContentBlock[] = [];
    let steered = false;

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

      totalToolCalls++;
      callbacks?.onToolEnd?.(call.name, result);
      emitAgentEvent({
        runId,
        stream: "tool",
        sessionKey,
        agentId,
        data: {
          phase: "end",
          name: call.name,
          output: result.length > 500 ? `${result.slice(0, 500)}...` : result,
        },
      });
      toolResults.push({
        type: "tool_result",
        tool_use_id: call.id,
        name: call.name,
        content: result,
      });

      // Steering 检查
      const steeringQueue = steeringQueues.get(sessionKey);
      if (steeringQueue && steeringQueue.length > 0) {
        steered = true;
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          sessionKey,
          agentId,
          data: { phase: "steering", pendingMessages: steeringQueue.length },
        });
        break;
      }
    }

    // 添加已执行的工具结果
    const resultMsg: Message = {
      role: "user",
      content: toolResults,
      timestamp: Date.now(),
    };
    await appendMessage(sessionKey, resultMsg);
    currentMessages.push(resultMsg);

    // 处理 steering 消息
    if (steered) {
      const steeringQueue = steeringQueues.get(sessionKey);
      if (steeringQueue && steeringQueue.length > 0) {
        const steeringText = steeringQueue.join("\n");
        steeringQueue.length = 0;

        const steeringMsg: Message = {
          role: "user",
          content: steeringText,
          timestamp: Date.now(),
        };
        await appendMessage(sessionKey, steeringMsg);
        currentMessages.push(steeringMsg);
      }
    }
  }

  return { finalText, turns, totalToolCalls };
}
