import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, RunResult } from "../src/agent.js";
import type { MiniAgentEvent } from "../src/agent-events.js";
import { handlers, type GwClient, type HandlerContext } from "../src/gateway/handlers.js";
import type { Message } from "../src/session.js";

function createAgentStub(): Agent {
  const listeners = new Set<(event: MiniAgentEvent) => void>();
  const history = new Map<string, Message[]>();

  return {
    subscribe(fn: (event: MiniAgentEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async run(
      sessionKey: string,
      userMessage: string,
      opts?: { runId?: string },
    ): Promise<RunResult> {
      const runId = opts?.runId ?? "stub-run";
      const user: Message = { role: "user", content: userMessage, timestamp: Date.now() };
      const assistant: Message = {
        role: "assistant",
        content: `echo:${userMessage}`,
        timestamp: Date.now(),
      };
      history.set(sessionKey, [user, assistant]);

      await Promise.resolve();
      for (const listener of listeners) {
        listener({
          type: "agent_start",
          runId,
          sessionKey,
          agentId: "main",
          model: "stub-model",
        });
        listener({ type: "message_delta", delta: `echo:${userMessage}` });
        listener({
          type: "message_end",
          message: assistant,
          text: `echo:${userMessage}`,
        });
        listener({
          type: "agent_end",
          runId,
          messages: [user, assistant],
        });
      }

      return {
        runId,
        text: `echo:${userMessage}`,
        turns: 1,
        toolCalls: 0,
      };
    },
    getHistory(sessionKey: string) {
      return history.get(sessionKey) ?? [];
    },
    async listSessions() {
      return Array.from(history.keys());
    },
    async reset(sessionKey: string) {
      history.delete(sessionKey);
    },
  } as unknown as Agent;
}

test("gateway handlers 能完成 connect、health 和 chat.send 的最小往返", async () => {
  const broadcasts: Array<{ event: string; payload: unknown }> = [];
  const sessionKey = "agent:main:gateway-test";
  const client: GwClient = {
    id: "client-1",
    authed: false,
    socket: {
      send() {},
      close() {},
      bufferedAmount: 0,
    },
  };
  const ctx: HandlerContext = {
    agent: createAgentStub(),
    broadcast: (event, payload) => {
      broadcasts.push({ event, payload });
    },
    clients: new Set([client]),
    token: "demo-token",
    nonces: new Map([[client.id, "nonce-1"]]),
    startedAt: Date.now(),
  };

  const connect = await handlers.connect({ token: "demo-token", nonce: "nonce-1" }, client, ctx);
  assert.equal(connect.ok, true);
  assert.equal(client.authed, true);

  const health = await handlers.health(undefined, client, ctx);
  assert.equal(health.ok, true);
  assert.equal((health.payload as { authedClients: number }).authedClients, 1);

  const chat = await handlers["chat.send"]({ sessionKey, message: "ping" }, client, ctx);
  assert.equal(chat.ok, true);

  const ack = chat.payload as { sessionKey: string; runId: string };
  assert.equal(ack.sessionKey, sessionKey);
  assert.ok(ack.runId);

  await new Promise<void>((resolve) => setImmediate(resolve));

  const finalEvent = broadcasts.find(
    (entry) =>
      entry.event === "chat" &&
      (entry.payload as { state?: string }).state === "final",
  );
  assert.ok(finalEvent);
  assert.equal(
    (finalEvent.payload as { runId?: string; text?: string }).runId,
    ack.runId,
  );
  assert.equal(
    (finalEvent.payload as { text?: string }).text,
    "echo:ping",
  );

  const history = await handlers["chat.history"]({ sessionKey }, client, ctx);
  assert.equal(history.ok, true);
  assert.equal(
    (history.payload as { messages: Message[] }).messages.length,
    2,
  );
});
