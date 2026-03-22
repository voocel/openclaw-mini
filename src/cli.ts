#!/usr/bin/env node
/**
 * Mini Agent CLI
 *
 * 交互设计:
 * - 线性滚动输出，不保留固定底部区域
 * - 输入提示始终跟随在最后一条消息之后
 * - 历史区仅保留用户/模型/工具事件，不保留输入框装饰
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { Agent } from "./index.js";
import { resolveSessionKey } from "./session-key.js";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { ApprovalConfig, ApprovalDecision, ApprovalRequest } from "./tool-approval.js";

// ============== .env 加载 ==============

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

loadEnvFile();

// ============== 样式 ==============

const styles = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  black: "\x1b[30m",
  white: "\x1b[37m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",

  bgWhite: "\x1b[47m",
  bgYellow: "\x1b[43m",
  bgGreen: "\x1b[42m",
  bgCyan: "\x1b[46m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
} as const;

const badgeStyles = {
  system: `${styles.black}${styles.bgWhite}`,
  input: `${styles.black}${styles.bgYellow}`,
  user: `${styles.black}${styles.bgGreen}`,
  model: `${styles.black}${styles.bgCyan}`,
  tool: `${styles.white}${styles.bgBlue}`,
  think: `${styles.white}${styles.bgMagenta}`,
  approve: `${styles.black}${styles.bgYellow}`,
} as const;

function color(text: string, c: keyof typeof styles): string {
  return `${styles[c]}${text}${styles.reset}`;
}

function badge(text: string, style: string): string {
  return `${style} ${text} ${styles.reset}`;
}

// ============== 输出状态 ==============

let unsubscribe: (() => void) | null = null;
let outputMode: "idle" | "thinking" | "assistant" = "idle";
type BlockKind = "system" | "user" | "tool" | "thinking" | "assistant" | "meta";
let lastBlockKind: BlockKind | null = null;

// 工具调用参数缓存（start 有 args，end 有 result，需关联）
const pendingToolArgs = new Map<string, unknown>();

function resetTerminal(): void {
  process.stdout.write("\x1b[?25h");
}

function closeOutputLine(): void {
  if (outputMode !== "idle") {
    process.stdout.write("\n");
    outputMode = "idle";
  }
}

function ensureBlockSpacing(kind: BlockKind): void {
  if (lastBlockKind && lastBlockKind !== kind) {
    process.stdout.write("\n");
  }
  lastBlockKind = kind;
}

function beginThinkingLine(): void {
  if (outputMode !== "thinking") {
    closeOutputLine();
    ensureBlockSpacing("thinking");
    process.stdout.write(`${badge("THINK", badgeStyles.think)} `);
    outputMode = "thinking";
  }
}

function beginAssistantLine(): void {
  if (outputMode !== "assistant") {
    closeOutputLine();
    ensureBlockSpacing("assistant");
    process.stdout.write(`${badge("MODEL", badgeStyles.model)} `);
    outputMode = "assistant";
  }
}

function printSystemLine(text: string, tone: "info" | "warn" | "error" = "info"): void {
  closeOutputLine();
  ensureBlockSpacing("system");
  let body = text;
  if (tone === "warn") body = color(text, "yellow");
  if (tone === "error") body = color(text, "yellow");
  console.log(`${badge("SYS", badgeStyles.system)} ${body}`);
}

function printUserLine(text: string): void {
  closeOutputLine();
  ensureBlockSpacing("user");
  console.log(`${badge("USER", badgeStyles.user)} ${text}`);
}

function printToolLine(text: string, isError = false): void {
  closeOutputLine();
  ensureBlockSpacing("tool");
  const body = isError ? color(text, "yellow") : color(text, "dim");
  console.log(`${badge("TOOL", badgeStyles.tool)} ${body}`);
}

function printMetaLine(text: string): void {
  closeOutputLine();
  ensureBlockSpacing("meta");
  console.log(`${color("↳", "dim")} ${text}`);
}

function clearPromptEchoLine(): void {
  // 删除 readline 刚回显的 "INPUT ❯ xxx" 行，避免历史污染
  process.stdout.write("\x1b[1A\x1b[2K\r");
}

// ============== 主函数 ==============

async function main() {
  const args = process.argv.slice(2);
  const provider = readFlag(args, "--provider") ?? process.env.OPENCLAW_MINI_PROVIDER ?? "anthropic";
  const model = readFlag(args, "--model") ?? process.env.OPENCLAW_MINI_MODEL;
  const baseUrl = readFlag(args, "--base-url") ?? process.env.OPENCLAW_MINI_BASE_URL;
  const reasoningFlag = readFlag(args, "--reasoning") ?? process.env.OPENCLAW_MINI_REASONING;
  const reasoning = reasoningFlag === "none" ? undefined : (reasoningFlag as any) ?? "medium";
  const apiKey = readFlag(args, "--api-key") ?? getEnvApiKey(provider);
  if (!apiKey) {
    console.error(`错误: 未找到 ${provider} 的 API Key，请设置对应环境变量或使用 --api-key 参数`);
    process.exit(1);
  }

  const agentId =
    readFlag(args, "--agent") ??
    process.env.OPENCLAW_MINI_AGENT_ID ??
    "main";
  const sessionId = resolveSessionIdArg(args) || `session-${Date.now()}`;
  const workspaceDir = process.cwd();
  const sessionKey = resolveSessionKey({ agentId, sessionId });

  // --approval 参数解析
  const approvalFlag = readFlag(args, "--approval");
  const approvalEnabled = args.includes("--approval");
  let approval: ApprovalConfig | undefined;
  if (approvalEnabled) {
    const ask = approvalFlag === "always" ? "always" as const : "on-miss" as const;
    approval = {
      ask,
      security: "full",
      tools: { exec: "allowlist", write: "allowlist", edit: "allowlist" },
    };
  }

  // readline（在 agent 之前创建，供审批处理器使用）
  const rlOutput = new Writable({
    write(chunk, _encoding, callback) {
      const text = typeof chunk === "string" ? chunk : chunk.toString();
      process.stdout.write(text.replace(/\x1b\[0?J/g, ""), callback);
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: rlOutput,
  });

  // 审批处理器（对齐 openclaw: CLI 模式下的 approval prompt）
  const onApprovalRequest = approval
    ? async (request: ApprovalRequest): Promise<ApprovalDecision> => {
        closeOutputLine();
        const label = formatToolCompact(request.toolName, request.args);
        return new Promise((resolve) => {
          rl.question(
            `${badge("?", badgeStyles.approve)} ${color("approve", "yellow")} ${label}? ${color("[y/n/a]", "dim")} `,
            (answer) => {
              const a = answer.trim().toLowerCase();
              if (a === "a" || a === "always") resolve("allow-always");
              else if (a === "n" || a === "no" || a === "d" || a === "deny") resolve("deny");
              else resolve("allow-once");
            },
          );
        });
      }
    : undefined;

  // Banner
  console.log(`${badge("MINI", badgeStyles.system)} ${color("OpenClaw Mini", "bold")}`);
  console.log(color(`  ${provider}${model ? ` · ${model}` : ""}${reasoning ? ` · thinking:${reasoning}` : ""} · ${agentId}`, "dim"));
  console.log(color(`  ${workspaceDir}`, "dim"));
  const hints = ["/help 查看命令"];
  if (approval) hints.push(`approval: ${approval.ask}`);
  hints.push("Ctrl+C 退出");
  console.log(color(`  ${hints.join(" · ")}`, "dim"));
  console.log();

  const agent = new Agent({
    apiKey,
    provider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    agentId,
    workspaceDir,
    reasoning,
    approval,
    onApprovalRequest,
  });

  // 事件订阅（对齐 pi-agent-core: Agent.subscribe → 类型化事件处理）
  unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        printSystemLine(`run ${event.runId.slice(0, 8)} · ${event.model}`);
        break;
      case "agent_end":
        break;
      case "agent_error":
        printSystemLine(`error: ${event.error}`, "error");
        break;

      case "thinking_delta":
        beginThinkingLine();
        process.stdout.write(color(event.delta, "dim"));
        break;

      case "message_delta":
        beginAssistantLine();
        process.stdout.write(event.delta);
        break;
      case "message_end":
        closeOutputLine();
        break;

      case "tool_execution_start": {
        pendingToolArgs.set(event.toolCallId, event.args);
        break;
      }
      case "tool_execution_end": {
        const toolArgs = pendingToolArgs.get(event.toolCallId);
        pendingToolArgs.delete(event.toolCallId);
        const label = formatToolCompact(event.toolName, toolArgs);
        const symbol = event.isError ? "✗" : "•";
        printToolLine(`${symbol} ${label}`, event.isError);
        break;
      }
      case "tool_skipped":
        printToolLine(`⊘ ${event.toolName} (skipped)`);
        break;

      case "tool_approval_resolved":
        if (event.decision === "deny") {
          printToolLine(`✗ ${event.toolName} (denied)`, true);
        } else if (event.decision === "allow-always") {
          printToolLine(`✓ ${event.toolName} (always allowed)`);
        }
        break;

      case "compaction":
        printSystemLine(`compaction: dropped ${event.droppedMessages} messages`);
        break;

      case "subagent_summary": {
        const l = event.label ? ` (${event.label})` : "";
        printSystemLine(`subagent${l}: ${event.summary.slice(0, 120)}`);
        break;
      }
      case "subagent_error":
        printSystemLine(`subagent error: ${event.error}`, "error");
        break;
    }
  });

  const prompt = () => {
    rl.question(`${badge("INPUT", badgeStyles.input)} ${color("❯", "green")} `, async (input) => {
      clearPromptEchoLine();

      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      // 仅把“真正发送的内容”写入历史显示
      printUserLine(trimmed);

      // 命令处理
      if (trimmed.startsWith("/")) {
        await handleCommand(trimmed, agent, sessionKey);
        console.log();
        prompt();
        return;
      }

      // Agent 执行
      outputMode = "idle";

      try {
        const result = await agent.run(sessionKey, trimmed);

        const parts = [
          `${color(String(result.turns), "cyan")} turns`,
          `${color(String(result.toolCalls), "yellow")} tools`,
          `${color(String(result.memoriesUsed ?? 0), "magenta")} memories`,
          `${color(String(result.text.length), "green")} chars`,
        ];
        printMetaLine(parts.join(color(" · ", "dim")));
      } catch (err) {
        closeOutputLine();
        printSystemLine((err as Error).message, "error");
      }
      prompt();
    });
  };

  prompt();
}

// ============== 工具函数 ==============

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((arg) => arg === name);
  if (idx === -1) return undefined;
  const next = args[idx + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next.trim() || undefined;
}

const FLAGS_WITH_VALUE = new Set(["--agent", "--model", "--provider", "--api-key", "--base-url", "--reasoning"]);

function resolveSessionIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "chat") continue;
    if (FLAGS_WITH_VALUE.has(arg)) { i += 1; continue; }
    if (arg.startsWith("--")) continue;
    return arg.trim() || undefined;
  }
  return undefined;
}

/** 提取工具调用的关键参数，生成紧凑摘要 */
function formatToolCompact(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, string>;
  switch (name) {
    case "read": return `read(${shortPath(a.file_path)})`;
    case "write": return `write(${shortPath(a.file_path)})`;
    case "edit": return `edit(${shortPath(a.file_path)})`;
    case "list": return `list(${a.path || "."})`;
    case "exec": return `exec(\`${String(a.command || "").slice(0, 50)}\`)`;
    case "grep": return `grep("${a.pattern || ""}"${a.path ? `, ${a.path}` : ""})`;
    case "memory_search": return `memory_search("${(a.query || "").slice(0, 30)}")`;
    case "memory_get": return `memory_get(${a.id || ""})`;
    case "memory_save": return `memory_save(${(a.content || "").slice(0, 30)}...)`;
    case "subagent": return `subagent("${(a.task || "").slice(0, 40)}")`;
    default: return name;
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : p;
}

async function handleCommand(cmd: string, agent: Agent, sessionKey: string) {
  const [command] = cmd.slice(1).split(" ");

  switch (command) {
    case "help":
      console.log(`命令:\n  /help     显示帮助\n  /reset    重置当前会话\n  /history  显示会话历史\n  /sessions 列出所有会话\n  /quit     退出\n\n启动参数:\n  --provider <name>   指定 provider (anthropic/openai/google/groq/...)\n  --model <id>        指定模型 ID\n  --base-url <url>    自定义 API 端点 (代理/自部署)\n  --api-key <key>     API Key\n  --reasoning <level> 思考级别 (minimal/low/medium/high/xhigh/none)\n  --approval          启用工具审批 (on-miss 模式)\n  --approval always   每次工具调用都需审批`);
      break;

    case "reset":
      await agent.reset(sessionKey);
      console.log(color("会话已重置", "green"));
      break;

    case "history": {
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
    }

    case "sessions": {
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
    }

    case "quit":
    case "exit":
      resetTerminal();
      process.exit(0);

    default:
      console.log(color(`未知命令: ${command}`, "yellow"));
  }
}

// 处理 Ctrl+C
process.on("SIGINT", () => {
  closeOutputLine();
  resetTerminal();
  console.log(color("\nBye!", "dim"));
  unsubscribe?.();
  process.exit(0);
});

main().catch((err) => {
  closeOutputLine();
  resetTerminal();
  console.error("启动失败:", err);
  process.exit(1);
});
