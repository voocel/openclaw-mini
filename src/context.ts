/**
 * 按需上下文加载 (Bootstrap Context)
 *
 * OpenClaw 的上下文加载:
 * - CLAUDE.md: 项目级长期规范
 * - HEARTBEAT.md: 主动唤醒时的任务清单
 * - Context Files: 动态注入的文件
 * - Skills Prompt: 技能描述注入
 *
 * 这里简化为: 基于文件的上下文注入系统
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface ContextFile {
  name: string;
  content: string;
  source: "workspace" | "user" | "system";
}

const CONTEXT_FILE_NAMES = [
  "AGENT.md",        // 项目级 Agent 规范 (类似 CLAUDE.md)
  "HEARTBEAT.md",    // 主动唤醒任务清单
  "CONTEXT.md",      // 额外上下文
];

const MAX_CONTEXT_CHARS = 20000;

export class ContextLoader {
  private workspaceDir: string;
  private userDir: string;

  constructor(workspaceDir: string, userDir: string = "~/.mini-agent") {
    this.workspaceDir = workspaceDir;
    this.userDir = userDir.replace("~", process.env.HOME || "");
  }

  /**
   * 加载所有上下文文件
   */
  async loadAll(): Promise<ContextFile[]> {
    const files: ContextFile[] = [];

    // 1. 加载用户级全局配置 (~/.mini-agent/AGENT.md)
    for (const name of CONTEXT_FILE_NAMES) {
      const userFile = await this.loadFile(path.join(this.userDir, name), "user");
      if (userFile) files.push(userFile);
    }

    // 2. 加载工作空间级配置 (./AGENT.md)
    for (const name of CONTEXT_FILE_NAMES) {
      const wsFile = await this.loadFile(path.join(this.workspaceDir, name), "workspace");
      if (wsFile) files.push(wsFile);
    }

    // 3. 加载 .mini-agent/ 目录下的上下文文件
    const agentDir = path.join(this.workspaceDir, ".mini-agent");
    for (const name of CONTEXT_FILE_NAMES) {
      const dirFile = await this.loadFile(path.join(agentDir, name), "workspace");
      if (dirFile) files.push(dirFile);
    }

    return files;
  }

  /**
   * 加载单个文件
   */
  private async loadFile(
    filePath: string,
    source: ContextFile["source"],
  ): Promise<ContextFile | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const trimmed = content.trim();
      if (!trimmed) return null;
      return {
        name: path.basename(filePath),
        content: trimmed.slice(0, MAX_CONTEXT_CHARS),
        source,
      };
    } catch {
      return null;
    }
  }

  /**
   * 构建系统提示的上下文部分
   */
  async buildContextPrompt(): Promise<string> {
    const files = await this.loadAll();
    if (files.length === 0) return "";

    const sections = files.map((f) => {
      const label = f.source === "user" ? "(global)" : "(workspace)";
      return `<context name="${f.name}" source="${label}">\n${f.content}\n</context>`;
    });

    return `\n\n## 上下文\n\n${sections.join("\n\n")}`;
  }

  /**
   * 检查 HEARTBEAT.md 是否有待办任务
   */
  async hasHeartbeatTasks(): Promise<boolean> {
    const files = await this.loadAll();
    const heartbeat = files.find((f) => f.name === "HEARTBEAT.md");
    if (!heartbeat) return false;

    // 检查是否有非空内容 (排除标题和空行)
    const lines = heartbeat.content.split("\n");
    return lines.some((line) => {
      const trimmed = line.trim();
      return trimmed && !/^#+(\s|$)/.test(trimmed) && !/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed);
    });
  }
}
