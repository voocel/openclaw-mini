/**
 * Gateway RPC 方法实现
 *
 * 对齐 OpenClaw:
 * - server-methods/connect.ts → connect 握手验证
 * - server-methods/chat.ts → chat.send / chat.history
 * - server-methods/sessions.ts → sessions.list / sessions.reset
 * - server-methods/health.ts → health
 *
 * Handler 签名对齐 openclaw GatewayRequestHandler:
 *   (params, client, ctx) → { ok, payload?, error? }
 */

import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.js";
import type { MiniAgentEvent } from "../agent-events.js";
import {
  ErrorCodes, errorShape,
  PROTOCOL_VERSION, GATEWAY_METHODS, GATEWAY_EVENTS,
  TICK_INTERVAL_MS, MAX_PAYLOAD_BYTES, newId,
  type HelloOk, type ErrorShape,
} from "./protocol.js";

// ============== 类型 ==============

export type GwClient = {
  id: string;
  socket: { send: (data: string) => void; close: (code?: number, reason?: string) => void; bufferedAmount: number };
  authed: boolean;
};

export type BroadcastFn = (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;

export type HandlerContext = {
  agent: Agent;
  broadcast: BroadcastFn;
  clients: Set<GwClient>;
  token?: string;
  nonces: Map<string, string>;
  startedAt: number;
};

export type HandlerResult = { ok: boolean; payload?: unknown; error?: ErrorShape };
export type Handler = (params: unknown, client: GwClient, ctx: HandlerContext) => Promise<HandlerResult>;

// ============== 安全工具（对齐 openclaw auth.ts safeEqual） ==============

/** 防计时攻击的字符串比较 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ============== connect ==============

const handleConnect: Handler = async (params, client, ctx) => {
  const p = params as { token?: string; nonce?: string } | undefined;

  // token 验证（对齐 openclaw auth.ts: timingSafeEqual 防计时攻击）
  if (ctx.token) {
    if (!p?.token || !safeEqual(p.token, ctx.token)) {
      return { ok: false, error: errorShape(ErrorCodes.UNAUTHORIZED, "invalid token") };
    }
  }

  // nonce 验证（对齐 openclaw challenge-response）
  const expectedNonce = ctx.nonces.get(client.id);
  if (expectedNonce && p?.nonce !== expectedNonce) {
    return { ok: false, error: errorShape(ErrorCodes.UNAUTHORIZED, "nonce mismatch") };
  }
  ctx.nonces.delete(client.id);

  client.authed = true;

  const hello: HelloOk = {
    protocol: PROTOCOL_VERSION,
    methods: [...GATEWAY_METHODS],
    events: [...GATEWAY_EVENTS],
    policy: { tickIntervalMs: TICK_INTERVAL_MS, maxPayloadBytes: MAX_PAYLOAD_BYTES },
  };
  return { ok: true, payload: hello };
};

// ============== chat.send ==============

/**
 * 对齐 openclaw server-methods/chat.ts:
 * 1. 立即返回 { sessionKey, runId } (ACK)
 * 2. 异步执行 agent.run()
 * 3. agent 事件流 → broadcast("agent") + broadcast("chat" delta/final)
 */
const handleChatSend: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string; message?: string } | undefined;
  if (!p?.message) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, "message required") };
  }
  const sessionKey = p.sessionKey || "main";
  const runId = newId();

  // 追踪 agent 内部的 runId（通过 agent_start 事件获取）
  let agentRunId: string | undefined = runId;

  // Delta 限流状态（对齐 openclaw server-chat.ts: 150ms 限流 + 文本累积）
  let deltaBuffer = "";
  let lastDeltaSentAt = 0;
  let lastDeltaSentLen = 0; // 上次广播时 buffer 的长度，用于计算新增部分
  const DELTA_THROTTLE_MS = 150;

  // 异步执行，不阻塞响应（对齐 openclaw chat.send 的 ACK-then-stream 模式）
  const unsub = ctx.agent.subscribe((event: MiniAgentEvent) => {
    // 捕获 agent 内部 runId，用于后续事件关联
    if (event.type === "agent_start" && event.sessionKey === sessionKey) {
      agentRunId = event.runId;
    }

    // 仅转发属于本次 run 的事件（按 sessionKey 过滤，避免并发混杂）
    const eventRunId = "runId" in event ? (event as { runId: string }).runId : undefined;
    if (eventRunId && eventRunId !== agentRunId) return;

    // 桥接 agent 事件 → gateway 广播
    ctx.broadcast("agent", { ...event, sessionKey });

    // 转换为 chat delta/final（对齐 openclaw emitChatDelta / emitChatFinal）
    if (event.type === "message_delta") {
      // Delta 限流（对齐 openclaw: 150ms 内最多发送一次，只广播新增部分）
      deltaBuffer += event.delta;
      const now = Date.now();
      if (now - lastDeltaSentAt >= DELTA_THROTTLE_MS) {
        lastDeltaSentAt = now;
        const newText = deltaBuffer.slice(lastDeltaSentLen);
        lastDeltaSentLen = deltaBuffer.length;
        ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "delta", text: newText }, { dropIfSlow: true });
      }
    } else if (event.type === "message_end") {
      // Final 发送完整文本（对齐 openclaw emitChatFinal: 从 buffer 取完整文本）
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "final", text: event.text });
    } else if (event.type === "agent_error") {
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "error", error: event.error });
    }
  });

  ctx.agent.run(sessionKey, p.message, { runId })
    .catch((err) => {
      // 广播运行时错误，确保客户端能收到错误通知
      ctx.broadcast("chat", { runId: agentRunId, sessionKey, state: "error", error: String(err) });
    })
    .finally(() => unsub());

  return { ok: true, payload: { sessionKey, runId } };
};

// ============== chat.history ==============

const handleChatHistory: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string } | undefined;
  const sessionKey = p?.sessionKey || "main";
  const messages = ctx.agent.getHistory(sessionKey);
  return { ok: true, payload: { sessionKey, messages } };
};

// ============== sessions.list ==============

const handleSessionsList: Handler = async (_params, _client, ctx) => {
  const sessions = await ctx.agent.listSessions();
  return { ok: true, payload: { sessions } };
};

// ============== sessions.reset ==============

const handleSessionsReset: Handler = async (params, _client, ctx) => {
  const p = params as { sessionKey?: string } | undefined;
  const sessionKey = p?.sessionKey || "main";
  await ctx.agent.reset(sessionKey);
  return { ok: true, payload: { sessionKey } };
};

// ============== health ==============

const handleHealth: Handler = async (_params, _client, ctx) => {
  return {
    ok: true,
    payload: {
      uptimeMs: Date.now() - ctx.startedAt,
      clients: ctx.clients.size,
      authedClients: [...ctx.clients].filter((c) => c.authed).length,
    },
  };
};

// ============== 方法注册表 ==============

export const handlers: Record<string, Handler> = {
  "connect": handleConnect,
  "chat.send": handleChatSend,
  "chat.history": handleChatHistory,
  "sessions.list": handleSessionsList,
  "sessions.reset": handleSessionsReset,
  "health": handleHealth,
};
