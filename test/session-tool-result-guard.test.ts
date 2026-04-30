import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SessionManager, type Message } from "../src/session.js";
import { installSessionToolResultGuard } from "../src/session-tool-result-guard.js";

test("缺失的 tool_result 会在后续消息到来前被自动补齐", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mini-guard-"));
  const sessions = new SessionManager(baseDir);
  const guard = installSessionToolResultGuard(sessions);
  const sessionKey = "agent:main:guard";

  const assistantToolUse: Message = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "read",
        input: { file_path: "package.json" },
      },
    ],
    timestamp: 1,
  };
  const userFollowUp: Message = {
    role: "user",
    content: "继续",
    timestamp: 2,
  };

  await sessions.append(sessionKey, assistantToolUse);
  assert.deepEqual(guard.getPendingIds(sessionKey), ["tool-1"]);

  await sessions.append(sessionKey, userFollowUp);
  assert.deepEqual(guard.getPendingIds(sessionKey), []);

  const history = await sessions.load(sessionKey);
  assert.equal(history.length, 3);

  const synthetic = history[1];
  assert.equal(synthetic.role, "user");
  assert.ok(Array.isArray(synthetic.content));
  assert.equal(synthetic.content[0]?.type, "tool_result");
  assert.equal(synthetic.content[0]?.tool_use_id, "tool-1");
  assert.match(synthetic.content[0]?.content ?? "", /synthetic error result/);
});
