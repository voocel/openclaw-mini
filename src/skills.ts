/**
 * 可扩展 Skills 系统
 *
 * 对应 OpenClaw:
 * - src/agents/skills/types.ts → 类型定义
 * - src/agents/skills/workspace.ts → 加载/合并/prompt 生成
 * - src/agents/skills/frontmatter.ts → YAML frontmatter 解析
 * - src/agents/skills/config.ts → eligibility 过滤
 * - src/auto-reply/skill-commands.ts → /command 匹配
 * - pi-coding-agent/core/skills.ts → loadSkillsFromDir, formatSkillsForPrompt
 *
 * 核心设计:
 * 1. SKILL.md 文件格式 (YAML frontmatter + markdown body)
 * 2. 多层目录加载，后加载的覆盖先加载的 (managed < workspace)
 *    OpenClaw 有 5 层 (extra < plugin < bundled < managed < workspace)，mini 简化为 2 层
 * 3. /skillname args 斜杠命令触发
 * 4. XML 格式 prompt 注入 (Agent Skills 标准: https://agentskills.io)
 * 5. 模型通过 read 工具按需加载 SKILL.md 详细指令
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

// ============== 类型定义 (对齐 openclaw types.ts) ==============

/**
 * Skill 定义
 *
 * 对应 pi-coding-agent: Skill 接口
 * - name 是唯一标识（对应目录名或 frontmatter name）
 * - filePath 指向 SKILL.md 绝对路径，模型可通过 read 工具按需读取
 */
export interface Skill {
  /** 技能名称（唯一标识，对应目录名或 frontmatter name） */
  name: string;
  /** 人类可读描述（注入到 prompt，告诉模型何时使用） */
  description: string;
  /** SKILL.md 文件绝对路径（模型可 read 该文件获取详细指令） */
  filePath: string;
  /** 技能所在目录 */
  baseDir: string;
  /** 来源标识: "managed" | "workspace"（workspace 覆盖 managed） */
  source: string;
  /** 是否禁止模型主动调用（true = 仅 /command 触发，不注入 prompt） */
  disableModelInvocation: boolean;
}

/**
 * 解析后的 frontmatter 键值对
 *
 * 对应 OpenClaw: ParsedSkillFrontmatter = Record<string, string>
 */
export type ParsedSkillFrontmatter = Record<string, string>;

/**
 * Skill 调用策略
 *
 * 对应 OpenClaw: SkillInvocationPolicy
 */
export type SkillInvocationPolicy = {
  /** 用户是否可通过 /command 调用 */
  userInvocable: boolean;
  /** 是否禁止注入到模型 prompt */
  disableModelInvocation: boolean;
};

/**
 * 加载后的完整 skill 条目
 *
 * 对应 OpenClaw: SkillEntry
 */
export type SkillEntry = {
  skill: Skill;
  frontmatter: ParsedSkillFrontmatter;
  invocation: SkillInvocationPolicy;
};

/**
 * Skill 命令规格（斜杠命令）
 *
 * 对应 OpenClaw: SkillCommandSpec
 */
export type SkillCommandSpec = {
  /** 命令名（sanitized，用于 /name 触发） */
  name: string;
  /** 原始 skill.name */
  skillName: string;
  /** 描述（截断至 100 字符） */
  description: string;
};

/**
 * 斜杠命令匹配结果
 *
 * 对应 OpenClaw: resolveSkillCommandInvocation 的返回值
 */
export interface SkillMatch {
  command: SkillCommandSpec;
  args?: string;
}

// ============== Frontmatter 解析 (对齐 openclaw frontmatter.ts) ==============

/**
 * 解析 YAML frontmatter
 *
 * 对应 OpenClaw: parseFrontmatterBlock()
 * - 简化版: 只解析 key: value 格式
 * - 所有值都转为 string（对齐 openclaw 的 coercion 策略）
 */
function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const result: ParsedSkillFrontmatter = {};
  for (const line of block.split("\n")) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/);
    if (kv) {
      result[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

/**
 * 解析调用策略
 *
 * 对应 OpenClaw: resolveSkillInvocationPolicy()
 */
function resolveInvocationPolicy(fm: ParsedSkillFrontmatter): SkillInvocationPolicy {
  return {
    userInvocable: parseBool(fm["user-invocable"], true),
    disableModelInvocation: parseBool(fm["disable-model-invocation"], false),
  };
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "1") return true;
  if (v === "false" || v === "no" || v === "0") return false;
  return fallback;
}

// ============== 文件加载 (对齐 pi-coding-agent loadSkillsFromDir) ==============

/**
 * 从目录加载 skills
 *
 * 对应 pi-coding-agent: loadSkillsFromDir()
 * - 根目录: 扫描直属 .md 文件
 * - 子目录: 递归查找 SKILL.md
 * - 跳过 node_modules 和 dotfiles
 */
async function loadSkillsFromDir(dir: string, source: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  let dirEntries: Dirent[];
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of dirEntries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 子目录: 查找 SKILL.md
      const skillPath = path.join(fullPath, "SKILL.md");
      const loaded = await loadSingleSkillFile(skillPath, fullPath, source);
      if (loaded) {
        entries.push(loaded);
      }
      // 递归搜索更深层子目录
      const subEntries = await loadSkillsFromDirRecursive(fullPath, source);
      entries.push(...subEntries);
    } else if (entry.name.endsWith(".md")) {
      // 根目录直属 .md 文件
      const loaded = await loadSingleSkillFile(fullPath, dir, source);
      if (loaded) {
        entries.push(loaded);
      }
    }
  }
  return entries;
}

/**
 * 递归扫描子目录中的 SKILL.md（不包含根目录 .md 文件）
 */
async function loadSkillsFromDirRecursive(dir: string, source: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  let dirEntries: Dirent[];
  try {
    dirEntries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return entries;
  }
  for (const entry of dirEntries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dir, entry.name);
    const skillPath = path.join(fullPath, "SKILL.md");
    const loaded = await loadSingleSkillFile(skillPath, fullPath, source);
    if (loaded) {
      entries.push(loaded);
    }
    const subEntries = await loadSkillsFromDirRecursive(fullPath, source);
    entries.push(...subEntries);
  }
  return entries;
}

/**
 * 加载单个 SKILL.md 文件
 */
async function loadSingleSkillFile(
  filePath: string,
  baseDir: string,
  source: string,
): Promise<SkillEntry | null> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  const frontmatter = parseFrontmatter(content);
  const invocation = resolveInvocationPolicy(frontmatter);
  // name: frontmatter > 父目录名 > 文件名
  const name = frontmatter.name?.trim()
    || path.basename(baseDir).toLowerCase()
    || path.basename(filePath, ".md").toLowerCase();
  const description = frontmatter.description?.trim() || "";
  if (!description) return null; // 对齐 pi-coding-agent: description 必填
  return {
    skill: {
      name,
      description,
      filePath: path.resolve(filePath),
      baseDir: path.resolve(baseDir),
      source,
      disableModelInvocation: invocation.disableModelInvocation,
    },
    frontmatter,
    invocation,
  };
}

// ============== Prompt 格式化 (对齐 pi-coding-agent formatSkillsForPrompt) ==============

const XML_ESCAPE_MAP: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function escapeXml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => XML_ESCAPE_MAP[ch] ?? ch);
}

/**
 * 生成 XML 格式的 skills prompt
 *
 * 对应 pi-coding-agent: formatSkillsForPrompt()
 * - Agent Skills 标准: https://agentskills.io/integrate-skills
 * - 只包含 disableModelInvocation=false 的 skill
 * - 模型看到描述后通过 read 工具读取 SKILL.md 获取详细指令
 */
function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const intro =
    "The following skills provide specialized instructions for specific tasks.\n" +
    "Use the read tool to load a skill's file when the task matches its description.\n";
  const items = visible.map(
    (s) =>
      `  <skill>\n` +
      `    <name>${escapeXml(s.name)}</name>\n` +
      `    <description>${escapeXml(s.description)}</description>\n` +
      `    <location>${escapeXml(s.filePath)}</location>\n` +
      `  </skill>`,
  );
  return `\n${intro}\n<available_skills>\n${items.join("\n")}\n</available_skills>`;
}

// ============== 命令名 sanitize (对齐 openclaw workspace.ts) ==============

const COMMAND_MAX_LENGTH = 32;
const DESCRIPTION_MAX_LENGTH = 100;

/**
 * 对应 OpenClaw: sanitizeSkillCommandName()
 */
function sanitizeCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, COMMAND_MAX_LENGTH) || "skill";
}

/**
 * 对应 OpenClaw: resolveUniqueSkillCommandName()
 */
function resolveUniqueCommandName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const suffix = `_${i}`;
    const maxBase = Math.max(1, COMMAND_MAX_LENGTH - suffix.length);
    const candidate = `${base.slice(0, maxBase)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, Math.max(1, COMMAND_MAX_LENGTH - 2))}_x`;
}

// ============== 命令匹配 (对齐 openclaw skill-commands.ts) ==============

/**
 * 归一化命令名用于模糊匹配
 *
 * 对应 OpenClaw: findSkillCommand 内的 normalize
 * - 小写化，空格/下划线统一转连字符
 */
function normalizeCommandName(raw: string): string {
  return raw.toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * 查找匹配的命令（3 种策略）
 *
 * 对应 OpenClaw: findSkillCommand()
 * 1. 精确匹配 name（大小写不敏感）
 * 2. 精确匹配 skillName（大小写不敏感）
 * 3. 归一化匹配（下划线/空格→连字符）
 */
function findCommand(
  commands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const lower = rawName.toLowerCase();
  const normalized = normalizeCommandName(rawName);
  return commands.find((c) => c.name.toLowerCase() === lower)
    ?? commands.find((c) => c.skillName.toLowerCase() === lower)
    ?? commands.find((c) => normalizeCommandName(c.name) === normalized);
}

/**
 * 对应 OpenClaw: resolveSkillCommandInvocation()
 *
 * 支持两种语法:
 * - /skillname args  — 直接触发
 * - /skill skillname args — 显式分发
 */
function resolveCommandInvocation(
  input: string,
  commands: SkillCommandSpec[],
): SkillMatch | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;

  // /skill skillname args
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;
    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;
    const target = skillMatch[1]?.trim() ?? "";
    const cmd = findCommand(commands, target);
    if (!cmd) return null;
    return { command: cmd, args: skillMatch[2]?.trim() || undefined };
  }

  // /skillname args
  const cmd = findCommand(commands, commandName);
  if (!cmd) return null;
  return { command: cmd, args: match[2]?.trim() || undefined };
}

// ============== SkillManager (对齐 openclaw workspace.ts 的 public API) ==============

export class SkillManager {
  private workspaceDir: string;
  private managedDir: string;
  /** 加载后的全部 entry（按 name 去重，后加载覆盖） */
  private entries: SkillEntry[] = [];
  /** 构建好的斜杠命令列表 */
  private commands: SkillCommandSpec[] = [];
  private loaded = false;

  /**
   * @param workspaceDir 工作目录（最高优先级 skill 来源）
   * @param managedDir 用户全局目录（~/.mini-agent/skills/）
   */
  constructor(workspaceDir: string, managedDir?: string) {
    this.workspaceDir = workspaceDir;
    this.managedDir = managedDir ?? path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".mini-agent",
      "skills",
    );
  }

  /**
   * 加载所有 skill（多层覆盖）
   *
   * 对应 OpenClaw: loadSkillEntries()
   * 优先级: managed < workspace（后者覆盖前者同名 skill）
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;

    const merged = new Map<string, SkillEntry>();

    // 1. managed skills (~/.mini-agent/skills/)
    const managedEntries = await loadSkillsFromDir(this.managedDir, "managed");
    for (const entry of managedEntries) {
      merged.set(entry.skill.name, entry);
    }

    // 2. workspace skills (./skills/) — 最高优先级
    const workspaceSkillsDir = path.join(this.workspaceDir, "skills");
    const workspaceEntries = await loadSkillsFromDir(workspaceSkillsDir, "workspace");
    for (const entry of workspaceEntries) {
      merged.set(entry.skill.name, entry);
    }

    this.entries = Array.from(merged.values());

    // 构建斜杠命令列表（对齐 buildWorkspaceSkillCommandSpecs）
    const used = new Set<string>();
    this.commands = [];
    for (const entry of this.entries) {
      if (!entry.invocation.userInvocable) continue;
      const base = sanitizeCommandName(entry.skill.name);
      const unique = resolveUniqueCommandName(base, used);
      used.add(unique.toLowerCase());
      const rawDesc = entry.skill.description || entry.skill.name;
      const description = rawDesc.length > DESCRIPTION_MAX_LENGTH
        ? `${rawDesc.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
        : rawDesc;
      this.commands.push({ name: unique, skillName: entry.skill.name, description });
    }

    this.loaded = true;
  }

  /**
   * 匹配斜杠命令
   *
   * 对应 OpenClaw: resolveSkillCommandInvocation()
   * 输入 "/review src/index.ts" → 匹配 review skill，args = "src/index.ts"
   */
  async match(input: string): Promise<SkillMatch | null> {
    await this.loadAll();
    return resolveCommandInvocation(input, this.commands);
  }

  /**
   * 按 name 获取 skill
   */
  async get(name: string): Promise<Skill | null> {
    await this.loadAll();
    const entry = this.entries.find((e) => e.skill.name === name);
    return entry?.skill ?? null;
  }

  /**
   * 列出所有 skill
   */
  async list(): Promise<Skill[]> {
    await this.loadAll();
    return this.entries.map((e) => e.skill);
  }

  /**
   * 列出斜杠命令
   */
  async listCommands(): Promise<SkillCommandSpec[]> {
    await this.loadAll();
    return this.commands;
  }

  /**
   * 构建系统提示中的 skills prompt（XML 格式）
   *
   * 对应 OpenClaw: buildWorkspaceSkillsPrompt() → formatSkillsForPrompt()
   * - 只包含 disableModelInvocation=false 的 skill
   * - 模型看到后通过 read 工具加载 SKILL.md 获取详细指令
   */
  async buildSkillsPrompt(): Promise<string> {
    await this.loadAll();
    const skills = this.entries
      .filter((e) => !e.invocation.disableModelInvocation)
      .map((e) => e.skill);
    return formatSkillsForPrompt(skills);
  }
}
