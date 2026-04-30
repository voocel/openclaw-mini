/**
 * Gateway 服务端
 *
 * 对齐 OpenClaw:
 * - server.impl.ts → startGatewayServer() 启动流程
 * - server/ws-connection.ts → WebSocket 连接处理 + challenge 握手
 * - server-broadcast.ts → createGatewayBroadcaster() Pub/Sub
 * - server-methods.ts → handleGatewayRequest() 方法路由
 * - server-maintenance.ts → tick 定时器
 * - server-close.ts → 优雅关闭
 *
 * 核心模式:
 * 1. Challenge-Response 握手
 * 2. 方法路由: RequestFrame.method → handlers[method]
 * 3. Pub/Sub 广播: broadcast(event, payload) → seq 递增 → 背压控制
 * 4. 心跳: 30s tick → 慢消费者检测
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { Agent } from "../agent.js";
import {
  type RequestFrame, type ResponseFrame, type EventFrame,
  isRequestFrame,
  ErrorCodes, errorShape, newId,
  TICK_INTERVAL_MS, MAX_BUFFERED_BYTES, HANDSHAKE_TIMEOUT_MS,
} from "./protocol.js";
import { handlers, type GwClient, type BroadcastFn, type HandlerContext } from "./handlers.js";

// ============== 类型 ==============

export type GatewayServerOptions = {
  port?: number;
  token?: string;
  agent: Agent;
};

export type GatewayServer = {
  close: (opts?: { restartExpectedMs?: number }) => void;
  port: number;
};

// ============== 广播器（对齐 openclaw server-broadcast.ts） ==============

/**
 * 对齐 openclaw server-broadcast.ts:
 * - seq 全局递增
 * - dropIfSlow: 非关键事件（tick、delta）跳过慢消费者而非断开
 * - 强制关闭: 关键事件时，慢消费者直接断开防止内存泄漏
 */
function createBroadcaster(clients: Set<GwClient>): BroadcastFn {
  let seq = 0;
  return (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => {
    const frame: EventFrame = { type: "event", event, payload, seq: ++seq };
    const data = JSON.stringify(frame);
    for (const c of clients) {
      if (!c.authed) continue;
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        // 非关键事件：跳过慢消费者（对齐 openclaw: dropIfSlow for tick/delta）
        continue;
      }
      if (slow) {
        // 关键事件：强制关闭慢消费者（对齐 openclaw: close 1008）
        c.socket.close(1008, "slow consumer");
        continue;
      }
      try { c.socket.send(data); } catch { /* 忽略已断开的连接 */ }
    }
  };
}

// ============== 启动服务 ==============

export async function startGatewayServer(opts: GatewayServerOptions): Promise<GatewayServer> {
  const requestedPort = opts.port ?? 18789;
  const clients = new Set<GwClient>();
  const nonces = new Map<string, string>();
  const broadcast = createBroadcaster(clients);
  const startedAt = Date.now();

  const ctx: HandlerContext = {
    agent: opts.agent,
    broadcast,
    clients,
    token: opts.token,
    nonces,
    startedAt,
  };

  // HTTP 服务（对齐 openclaw server-http.ts createGatewayHttpServer）
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "mini-gateway", uptimeMs: Date.now() - startedAt }));
  });

  // WebSocket 服务（对齐 openclaw: new WebSocketServer + attachGatewayUpgradeHandler）
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    const connId = newId();
    const client: GwClient = { id: connId, socket, authed: false };
    clients.add(client);

    // 1. 发送 challenge（对齐 openclaw ws-connection.ts: connect.challenge 事件）
    const nonce = newId();
    nonces.set(connId, nonce);
    send(socket, { type: "event", event: "connect.challenge", payload: { nonce, ts: Date.now() }, seq: 0 });

    // 2. 握手超时（对齐 openclaw: DEFAULT_HANDSHAKE_TIMEOUT_MS）
    const handshakeTimer = setTimeout(() => {
      if (!client.authed) {
        socket.close(4000, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);

    // 3. 消息处理（对齐 openclaw message-handler.ts: socket.on("message")）
    socket.on("message", async (raw) => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { return; }

      if (!isRequestFrame(parsed)) return;
      const req = parsed as RequestFrame;

      // 未认证时只允许 connect 方法
      if (!client.authed && req.method !== "connect") {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.UNAUTHORIZED, "not authenticated"));
        return;
      }

      // 方法路由（对齐 openclaw server-methods.ts: handleGatewayRequest）
      const handler = handlers[req.method];
      if (!handler) {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`));
        return;
      }

      try {
        const result = await handler(req.params, client, ctx);
        respond(socket, req.id, result.ok, result.payload, result.error);
        if (req.method === "connect" && result.ok) {
          clearTimeout(handshakeTimer);
        }
      } catch (err) {
        respond(socket, req.id, false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
      }
    });

    // 4. 连接关闭清理
    socket.on("close", () => {
      clearTimeout(handshakeTimer);
      clients.delete(client);
      nonces.delete(connId);
    });

    socket.on("error", () => {
      clients.delete(client);
      nonces.delete(connId);
    });
  });

  // Tick 定时器（对齐 openclaw server-maintenance.ts: 30s tick 广播，可丢弃）
  const tickTimer = setInterval(() => {
    broadcast("tick", { ts: Date.now() }, { dropIfSlow: true });
  }, TICK_INTERVAL_MS);

  // 监听
  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(requestedPort, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address() as AddressInfo | null;
  const port = address?.port ?? requestedPort;

  // 优雅关闭（对齐 openclaw server-close.ts: createGatewayCloseHandler）
  const close = (opts?: { restartExpectedMs?: number }) => {
    broadcast("shutdown", {
      reason: "server closing",
      restartExpectedMs: opts?.restartExpectedMs ?? null,
    });
    clearInterval(tickTimer);
    for (const c of clients) {
      try { c.socket.close(1012, "service restart"); } catch {}
    }
    clients.clear();
    wss.close();
    httpServer.close();
  };

  return { close, port };
}

// ============== 帮助函数 ==============

function send(socket: WebSocket, frame: EventFrame | ResponseFrame): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
}

function respond(socket: WebSocket, id: string, ok: boolean, payload?: unknown, error?: import("./protocol.js").ErrorShape): void {
  send(socket, { type: "res", id, ok, payload, error });
}
