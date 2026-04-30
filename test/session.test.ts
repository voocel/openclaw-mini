import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { SessionManager, type Message } from "../src/session.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("session 只有在首条 assistant 消息后才会落盘", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mini-session-"));
  const sessions = new SessionManager(baseDir);
  const sessionKey = "agent:main:demo";
  const filePath = path.join(baseDir, `${encodeURIComponent(sessionKey)}.jsonl`);

  const user: Message = { role: "user", content: "hello", timestamp: 1 };
  const assistant: Message = { role: "assistant", content: "world", timestamp: 2 };

  await sessions.append(sessionKey, user);
  assert.equal(await exists(filePath), false);

  await sessions.append(sessionKey, assistant);
  assert.equal(await exists(filePath), true);
  assert.deepEqual(await sessions.load(sessionKey), [user, assistant]);
  assert.deepEqual(await sessions.list(), [sessionKey]);

  await sessions.clear(sessionKey);
  assert.equal(await exists(filePath), false);
});
