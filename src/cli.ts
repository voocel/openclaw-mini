#!/usr/bin/env node
/**
 * Mini Agent CLI
 */

import readline from "node:readline";
import { Agent } from "./agent.js";
import { resolveSessionKey } from "./session-key.js";

// ============== 颜色输出 ==============

const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
};

function color(text: string, c: keyof typeof colors): string {
  return `${colors[c]}${text}${colors.reset}`;
}

// ============== 主函数 ==============

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("错误: 请设置 ANTHROPIC_API_KEY 环境变量");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const agentId =
    readFlag(args, "--agent") ??
    process.env.OPENCLAW_MINI_AGENT_ID ??
    "main";
  const sessionId = resolveSessionIdArg(args) || `session-${Date.now()}`;
  const workspaceDir = process.cwd();
  const sessionKey = resolveSessionKey({ agentId, sessionId });

  console.log(color("\n🤖 Mini Agent", "cyan"));
  console.log(color(`会话: ${sessionKey}`, "dim"));
  console.log(color(`Agent: ${agentId}`, "dim"));
  console.log(color(`目录: ${workspaceDir}`, "dim"));
  console.log(color("输入 /help 查看命令，Ctrl+C 退出\n", "dim"));

  const agent = new Agent({
    apiKey,
    agentId,
    workspaceDir,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(color("你: ", "green"), async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // 命令处理
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, agent, sessionKey);
        prompt();
        return;
      }

      // 运行 Agent
      process.stdout.write(color("\nAgent: ", "blue"));

      try {
        const result = await agent.run(sessionKey, trimmed, {
          onTextDelta: (delta) => process.stdout.write(delta),
          onToolStart: (name, input) => {
            console.log(color(`\n  [工具] ${name}`, "yellow"));
            const inputStr = JSON.stringify(input);
            if (inputStr.length < 100) {
              console.log(color(`  参数: ${inputStr}`, "dim"));
            }
          },
          onToolEnd: (name, result) => {
            const preview = result.slice(0, 200).replace(/\n/g, "\\n");
            console.log(color(`  结果: ${preview}${result.length > 200 ? "..." : ""}`, "dim"));
          },
        });

        console.log(color(`\n\n  [${result.turns} 轮, ${result.toolCalls} 次工具调用]`, "dim"));
      } catch (err) {
        console.error(color(`\n错误: ${(err as Error).message}`, "yellow"));
      }

      console.log();
      prompt();
    });
  };

  prompt();
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((arg) => arg === name);
  if (idx === -1) {
    return undefined;
  }
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) {
    return undefined;
  }
  return next.trim() || undefined;
}

function resolveSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "chat") {
      continue;
    }
    if (arg === "--agent") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    return arg.trim() || undefined;
  }
  return undefined;
}

async function handleCommand(cmd: string, agent: Agent, sessionKey: string) {
  const [command, ...args] = cmd.slice(1).split(" ");

  switch (command) {
    case "help":
      console.log(`
命令:
  /help     显示帮助
  /reset    重置当前会话
  /history  显示会话历史
  /sessions 列出所有会话
  /quit     退出
`);
      break;

    case "reset":
      await agent.reset(sessionKey);
      console.log(color("会话已重置", "green"));
      break;

    case "history":
      const history = agent.getHistory(sessionKey);
      if (history.length === 0) {
        console.log(color("暂无历史", "dim"));
      } else {
        for (const msg of history) {
          const role = msg.role === "user" ? "你" : "Agent";
          const content =
            typeof msg.content === "string"
              ? msg.content
              : msg.content.map((c) => c.text || `[${c.type}]`).join(" ");
          console.log(`${color(role + ":", role === "你" ? "green" : "blue")} ${content.slice(0, 100)}...`);
        }
      }
      break;

    case "sessions":
      const sessions = await agent.listSessions();
      if (sessions.length === 0) {
        console.log(color("暂无会话", "dim"));
      } else {
        console.log("会话列表:");
        for (const s of sessions) {
          console.log(`  - ${s}${s === sessionKey ? color(" (当前)", "cyan") : ""}`);
        }
      }
      break;

    case "quit":
    case "exit":
      process.exit(0);

    default:
      console.log(color(`未知命令: ${command}`, "yellow"));
  }
}

// 处理 Ctrl+C
process.on("SIGINT", () => {
  console.log(color("\n\n再见! 👋", "cyan"));
  process.exit(0);
});

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
