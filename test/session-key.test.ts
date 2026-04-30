import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentMainSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  resolveSessionKey,
} from "../src/session-key.js";

test("session key 会统一 agent/session 规范", () => {
  assert.equal(normalizeAgentId(" Demo Agent "), "demo-agent");
  assert.equal(buildAgentMainSessionKey({ agentId: "Main" }), "agent:main:main");
  assert.equal(
    resolveSessionKey({ agentId: "Demo Agent", sessionId: "Work" }),
    "agent:demo-agent:work",
  );
  assert.equal(
    resolveSessionKey({ agentId: "main", sessionKey: "agent:Other:subagent:123" }),
    "agent:other:subagent:123",
  );
});

test("subagent session 能被识别并解析出 agentId", () => {
  const sessionKey = "agent:worker:subagent:abc-123";
  assert.equal(isSubagentSessionKey(sessionKey), true);
  assert.equal(resolveAgentIdFromSessionKey(sessionKey), "worker");
});
