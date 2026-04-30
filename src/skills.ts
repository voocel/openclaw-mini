/**
 * Skill 编排层（对应 OpenClaw src/agents/skills/）
 *
 * 在 skill-primitives（SDK 层）之上构建，只做 SDK 不提供的编排和策略:
 * - 多层目录加载与合并 (managed < workspace)
 * - Frontmatter 元数据提取（SDK 之外的字段）
 * - 调用策略解析 (userInvocable / disableModelInvocation)
 * - /command 斜杠命令匹配
 * - 命令名 sanitize + 去重
 * - SkillManager 公开 API
 *
 * 分层对应关系:
 *   OpenClaw workspace.ts:1-5 →
 *     import { formatSkillsForPrompt, loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent"
 *   Mini skills.ts:下方 →
 *     import { type Skill, loadSkillsFromDir, formatSkillsForPrompt } from "./skill-primitives.js"
 *
 * 即: SDK 提供原语，编排层做策略。
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * 底层原语来自 skill-primitives（对应 pi-coding-agent SDK）
 *
 * OpenClaw 对应: import { ... } from "@mariozechner/pi-coding-agent"
 */
import {
  type Skill,
  loadSkillsFromDir,
  formatSkillsForPrompt,
  extractFrontmatter,
  parseBool,
} from "./skill-primitives.js";

// Re-export SDK 类型供外部使用
export type { Skill };

// ============== 类型定义 (对应 openclaw types.ts) ==============

/**
 * 解析后的 frontmatter 键值对
 *
 * 对应 OpenClaw: ParsedSkillFrontmatter
 * 所有值都被强制转为 string（对齐 openclaw 的 coercion 策略）
 */
export type ParsedSkillFrontmatter = Record<string, string>;

/**
 * Skill 调用策略
 *
 * 对应 OpenClaw: SkillInvocationPolicy
 * 两个布尔值独立控制两条触发通道:
 * - userInvocable 控制用户 /command 通道
 * - disableModelInvocation 控制模型自主触发通道
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
 * - skill 字段来自 SDK 的 loadSkillsFromDir（底层原语）
 * - frontmatter/invocation 由编排层重读文件后提取（SDK 不关心这些字段）
 */
export type SkillEntry = {
  /** SDK 返回的 Skill 对象（name/description/filePath/baseDir/source） */
  skill: Skill;
  /** 编排层解析的完整 frontmatter 键值对 */
  frontmatter: ParsedSkillFrontmatter;
  /** 调用策略（控制用户 /command 和模型自主调用两个通道） */
  invocation: SkillInvocationPolicy;
};

/**
 * Skill 命令规格（斜杠命令注册条目）
 *
 * 对应 OpenClaw: SkillCommandSpec
 * 由 buildSkillCommandSpecs() 从 SkillEntry[] 构建，
 * 用于 /command 匹配和命令列表展示
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
  /** 匹配到的命令规格 */
  command: SkillCommandSpec;
  /** 命令后的参数部分（如 "/commit -m fix" 中的 "-m fix"） */
  args?: string;
}

// ============== Frontmatter 解析 (对应 openclaw frontmatter.ts) ==============
// extractFrontmatter 和 parseBool 复用 skill-primitives.ts 的实现（SDK 层原语）

/** 对应 OpenClaw: resolveSkillInvocationPolicy() */
function resolveInvocationPolicy(fm: ParsedSkillFrontmatter): SkillInvocationPolicy {
  return {
    userInvocable: parseBool(fm["user-invocable"], true),
    disableModelInvocation: parseBool(fm["disable-model-invocation"], false),
  };
}

// ============== Skill 加载与合并 (对应 openclaw workspace.ts) ==============

/**
 * 加载 skill 条目（多层合并 + 元数据丰富）
 *
 * 对应 OpenClaw: loadSkillEntries()
 * 流程:
 * 1. 调用 SDK 的 loadSkillsFromDir 扫描多个目录 → Skill[]
 * 2. name-based Map 合并（后加载覆盖先加载）
 * 3. 重读文件提取编排层的 frontmatter 元数据 → SkillEntry[]
 *
 * 这里的「重读文件」对应 OpenClaw workspace.ts:173-188 的做法：
 * SDK 已经读过一次提取了 name/description，但编排层需要
 * 提取 SDK 不关心的字段（user-invocable 等），所以再读一次。
 */
async function loadSkillEntries(
  workspaceDir: string,
  managedDir: string,
): Promise<SkillEntry[]> {
  const merged = new Map<string, Skill>();

  // 优先级: managed < workspace（对应 OpenClaw 的 extra < bundled < managed < workspace）
  const managedSkills = await loadSkillsFromDir({ dir: managedDir, source: "managed" });
  for (const skill of managedSkills) {
    merged.set(skill.name, skill);
  }

  const workspaceSkillsDir = path.join(workspaceDir, "skills");
  const workspaceSkills = await loadSkillsFromDir({
    dir: workspaceSkillsDir,
    source: "workspace",
  });
  for (const skill of workspaceSkills) {
    merged.set(skill.name, skill);
  }

  // 丰富为 SkillEntry（重读文件提取编排层元数据）
  const entries: SkillEntry[] = [];
  for (const skill of merged.values()) {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = await fs.readFile(skill.filePath, "utf-8");
      frontmatter = extractFrontmatter(raw);
    } catch {
      // ignore
    }
    entries.push({
      skill,
      frontmatter,
      invocation: resolveInvocationPolicy(frontmatter),
    });
  }
  return entries;
}

// ============== 命令名 sanitize (对应 openclaw workspace.ts) ==============

const COMMAND_MAX_LENGTH = 32;
const COMMAND_FALLBACK = "skill";
const DESCRIPTION_MAX_LENGTH = 100; // Discord limit

/** 对应 OpenClaw: sanitizeSkillCommandName() */
function sanitizeCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.slice(0, COMMAND_MAX_LENGTH) || COMMAND_FALLBACK;
}

/** 对应 OpenClaw: resolveUniqueSkillCommandName() */
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

/**
 * 构建斜杠命令列表
 *
 * 对应 OpenClaw: buildWorkspaceSkillCommandSpecs()
 */
function buildSkillCommandSpecs(entries: SkillEntry[]): SkillCommandSpec[] {
  const userInvocable = entries.filter((e) => e.invocation.userInvocable !== false);
  const used = new Set<string>();
  const specs: SkillCommandSpec[] = [];

  for (const entry of userInvocable) {
    const base = sanitizeCommandName(entry.skill.name);
    const unique = resolveUniqueCommandName(base, used);
    used.add(unique.toLowerCase());

    const rawDesc = entry.skill.description?.trim() || entry.skill.name;
    const description =
      rawDesc.length > DESCRIPTION_MAX_LENGTH
        ? `${rawDesc.slice(0, DESCRIPTION_MAX_LENGTH - 1)}…`
        : rawDesc;

    specs.push({ name: unique, skillName: entry.skill.name, description });
  }
  return specs;
}

// ============== 命令匹配 (对应 openclaw skill-commands.ts) ==============

/**
 * 归一化命令名用于模糊查找
 *
 * 对应 OpenClaw: normalizeSkillCommandLookup()
 */
function normalizeForLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * 模糊查找命令（单次遍历，4 种策略）
 *
 * 对应 OpenClaw: findSkillCommand()
 * 仅用于 /skill skillname args 路径（允许灵活匹配）
 */
function findSkillCommand(
  commands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const normalized = normalizeForLookup(trimmed);

  // 单次遍历，第一个命中任一策略的即返回（对齐 openclaw 实现）
  return commands.find((entry) => {
    if (entry.name.toLowerCase() === lowered) return true;
    if (entry.skillName.toLowerCase() === lowered) return true;
    return (
      normalizeForLookup(entry.name) === normalized ||
      normalizeForLookup(entry.skillName) === normalized
    );
  });
}

/**
 * 解析斜杠命令
 *
 * 对应 OpenClaw: resolveSkillCommandInvocation()
 *
 * 两种语法的匹配策略不同（与 openclaw 一致）:
 * - /skill skillname args → findSkillCommand（灵活匹配 name + skillName + 归一化）
 * - /skillname args → 严格匹配 command.name only
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

  // /skill skillname args — 灵活匹配
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;
    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;
    const cmd = findSkillCommand(commands, skillMatch[1] ?? "");
    if (!cmd) return null;
    return { command: cmd, args: skillMatch[2]?.trim() || undefined };
  }

  // /skillname args — 严格匹配 name（对齐 openclaw: entry.name.toLowerCase() === commandName）
  const cmd = commands.find((entry) => entry.name.toLowerCase() === commandName);
  if (!cmd) return null;
  return { command: cmd, args: match[2]?.trim() || undefined };
}

// ============== SkillManager (对应 openclaw workspace.ts 的 public API) ==============

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
   * @param managedDir 用户全局目录（~/.openclaw-mini/skills/）
   */
  constructor(workspaceDir: string, managedDir?: string) {
    this.workspaceDir = workspaceDir;
    this.managedDir =
      managedDir ??
      path.join(
        process.env.HOME || process.env.USERPROFILE || ".",
        ".openclaw-mini",
        "skills",
      );
  }

  /**
   * 加载所有 skill（多层合并 + 命令列表构建）
   *
   * 对应 OpenClaw: loadSkillEntries() + buildWorkspaceSkillCommandSpecs()
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.entries = await loadSkillEntries(this.workspaceDir, this.managedDir);
    this.commands = buildSkillCommandSpecs(this.entries);
    this.loaded = true;
  }

  /**
   * 匹配斜杠命令
   *
   * 对应 OpenClaw: resolveSkillCommandInvocation()
   */
  async match(input: string): Promise<SkillMatch | null> {
    await this.loadAll();
    return resolveCommandInvocation(input, this.commands);
  }

  /** 按 name 获取 skill */
  async get(name: string): Promise<Skill | null> {
    await this.loadAll();
    return this.entries.find((e) => e.skill.name === name)?.skill ?? null;
  }

  /** 列出所有 skill */
  async list(): Promise<Skill[]> {
    await this.loadAll();
    return this.entries.map((e) => e.skill);
  }

  /** 列出斜杠命令 */
  async listCommands(): Promise<SkillCommandSpec[]> {
    await this.loadAll();
    return this.commands;
  }

  /**
   * 构建系统提示中的 skills prompt（XML 格式）
   *
   * 对应 OpenClaw: buildWorkspaceSkillsPrompt() → formatSkillsForPrompt()
   * - 只包含 disableModelInvocation=false 的 skill
   * - 调用 SDK 的 formatSkillsForPrompt 生成 XML
   */
  async buildSkillsPrompt(): Promise<string> {
    await this.loadAll();
    const skills = this.entries
      .filter((e) => !e.invocation.disableModelInvocation)
      .map((e) => e.skill);
    return formatSkillsForPrompt(skills);
  }
}
