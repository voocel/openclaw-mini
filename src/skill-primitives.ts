/**
 * Skill 底层原语（对应 pi-coding-agent SDK 层）
 *
 * 本文件模拟 @mariozechner/pi-coding-agent 提供的 skill 基础能力:
 * - Skill 类型定义
 * - loadSkillsFromDir() — 目录扫描与 SKILL.md 解析
 * - formatSkillsForPrompt() — XML prompt 生成 (Agent Skills 标准)
 *
 * OpenClaw 不自己实现这些原语，而是直接引用 SDK:
 *   import { Skill, loadSkillsFromDir, formatSkillsForPrompt } from "@mariozechner/pi-coding-agent"
 *
 * Mini 因为不依赖 SDK，所以在此自行实现。上层 skills.ts 通过
 *   import { type Skill, loadSkillsFromDir, formatSkillsForPrompt } from "./skill-primitives.js"
 * 复用这些原语，与 OpenClaw 的分层结构一一对应。
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

// ============== 类型 ==============

/**
 * Skill 定义（对应 pi-coding-agent 的 Skill 接口）
 *
 * SDK 只关心最基本的字段，不涉及任何编排层概念（调用策略、命令匹配等）
 * - name 是唯一标识（对应目录名或 frontmatter name）
 * - filePath 指向 SKILL.md 绝对路径，模型可通过 read 工具按需读取
 */
export interface Skill {
  /** 技能名称（唯一标识，来自 frontmatter 或父目录名） */
  name: string;
  /** 人类可读描述（注入到 <available_skills> prompt，告诉模型何时使用） */
  description: string;
  /** SKILL.md 文件绝对路径（模型通过 read 工具读取获取详细指令） */
  filePath: string;
  /** 技能所在目录（SKILL.md 中的相对路径基于此目录解析） */
  baseDir: string;
  /** 来源标识（如 "managed"、"workspace"），用于多层覆盖时追溯优先级 */
  source: string;
  /** 是否禁止模型主动调用（true = 不注入 prompt，仅可通过 /command 触发） */
  disableModelInvocation: boolean;
}

// ============== 目录扫描 ==============

/**
 * 从目录加载 skills
 *
 * 对应 pi-coding-agent: loadSkillsFromDir()
 * 发现规则:
 * - 根目录: 任意 .md 文件
 * - 子目录（递归）: 仅 SKILL.md
 * - 跳过 dotfiles 和 node_modules
 */
export async function loadSkillsFromDir(params: {
  dir: string;
  source: string;
}): Promise<Skill[]> {
  const { dir, source } = params;
  const skills: Skill[] = [];

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const skill = await loadSkillFromFile(
        path.join(fullPath, "SKILL.md"),
        fullPath,
        source,
      );
      if (skill) skills.push(skill);
      // 递归子目录
      const sub = await scanSubdirs(fullPath, source);
      skills.push(...sub);
    } else if (entry.name.endsWith(".md")) {
      const skill = await loadSkillFromFile(fullPath, dir, source);
      if (skill) skills.push(skill);
    }
  }
  return skills;
}

/** 递归子目录扫描（仅查找 SKILL.md） */
async function scanSubdirs(dir: string, source: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return skills;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    const skill = await loadSkillFromFile(
      path.join(fullPath, "SKILL.md"),
      fullPath,
      source,
    );
    if (skill) skills.push(skill);
    const sub = await scanSubdirs(fullPath, source);
    skills.push(...sub);
  }
  return skills;
}

/**
 * 加载单个 skill 文件
 *
 * 对应 pi-coding-agent 内部: loadSkillFromFile
 * - 解析 YAML frontmatter 提取 name, description, disable-model-invocation
 * - name: frontmatter > 父目录名 > 文件名（去 .md）
 * - description 必填，无描述则跳过
 */
async function loadSkillFromFile(
  filePath: string,
  baseDir: string,
  source: string,
): Promise<Skill | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  const fm = extractFrontmatter(content);
  // name 优先级: frontmatter 声明 > 父目录名 > 文件名（去 .md）
  const name =
    fm.name?.trim() ||
    path.basename(baseDir).toLowerCase() ||
    path.basename(filePath, ".md").toLowerCase();
  const description = fm.description?.trim() || "";
  if (!description) return null;

  return {
    name,
    description,
    filePath: path.resolve(filePath),
    baseDir: path.resolve(baseDir),
    source,
    disableModelInvocation: parseBool(fm["disable-model-invocation"], false),
  };
}

/**
 * 简易 YAML frontmatter 提取
 *
 * 对应 pi-coding-agent 内部的 frontmatter 解析器
 * - 只处理 key: value 单行格式
 * - 去除引号包裹（"value" → value）
 * - SDK 层只需提取 name/description/disable-model-invocation
 *   编排层（skills.ts）会重读文件用自己的解析器提取更多字段
 */
export function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return fallback;
}

// ============== Prompt 格式化 ==============

const XML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch] ?? ch);
}

/**
 * 生成 XML 格式的 skills prompt
 *
 * 对应 pi-coding-agent: formatSkillsForPrompt()
 * - Agent Skills 标准: https://agentskills.io
 * - 自动过滤 disableModelInvocation === true 的 skill
 * - 输出格式与 pi-coding-agent 完全一致
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(s.name)}</name>`);
    lines.push(`    <description>${escapeXml(s.description)}</description>`);
    lines.push(`    <location>${escapeXml(s.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}
