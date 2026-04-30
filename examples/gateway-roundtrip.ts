/**
 * Gateway 一体化示例
 *
 * 单进程同时启动:
 * - Agent
 * - Gateway Server
 * - Gateway Client
 *
 * 适合快速理解 ACK-then-stream 的完整链路。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Agent } from "../src/index.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import type { EventFrame } from "../src/gateway/protocol.js";
import { getEnvApiKey } from "@mariozechner/pi-ai";

function loadEnvFile(dir: string = process.cwd()): void {
  const envPath = path.join(dir, ".env");
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function main() {
  loadEnvFile();

  const provider = process.env.OPENCLAW_MINI_PROVIDER ?? "anthropic";
  const model = process.env.OPENCLAW_MINI_MODEL;
  const baseUrl = process.env.OPENCLAW_MINI_BASE_URL;
  const apiKey = getEnvApiKey(provider);

  if (!apiKey) {
    throw new Error(`未找到 ${provider} 的 API Key，请先配置 .env 或环境变量`);
  }

  const agent = new Agent({
    apiKey,
    provider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    workspaceDir: process.cwd(),
  });

  const token = crypto.randomUUID();
  const gateway = await startGatewayServer({
    port: 0,
    token,
    agent,
  });
  const url = `ws://127.0.0.1:${gateway.port}`;
  const sessionKey = "agent:main:gateway-example";

  let resolveDone: (() => void) | null = null;
  let rejectDone: ((error: Error) => void) | null = null;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const client = new GatewayClient({
    url,
    token,
    autoReconnect: false,
    onEvent: (event: EventFrame) => {
      if (event.event !== "chat") return;
      const payload = event.payload as {
        runId?: string;
        state?: string;
        text?: string;
        error?: string;
      };
      if (payload.state === "delta" && payload.text) {
        process.stdout.write(payload.text);
      } else if (payload.state === "final") {
        process.stdout.write("\n");
        resolveDone?.();
      } else if (payload.state === "error") {
        rejectDone?.(new Error(payload.error ?? "unknown gateway error"));
      }
    },
  });

  try {
    const hello = await client.connect();
    const health = await client.request<{ uptimeMs: number; authedClients: number }>("health");

    console.log("Gateway 一体化示例\n");
    console.log(`gateway: ${url}`);
    console.log(`protocol: v${hello.protocol}`);
    console.log(`authed clients: ${health.authedClients}`);
    console.log(`session: ${sessionKey}\n`);

    const ack = await client.request<{ sessionKey: string; runId: string }>("chat.send", {
      sessionKey,
      message: "读取当前目录下的 package.json，并告诉我 name 字段是什么。",
    });

    console.log(`ACK: session=${ack.sessionKey} runId=${ack.runId}`);
    console.log("MODEL:");

    await done;
  } finally {
    client.close();
    gateway.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
