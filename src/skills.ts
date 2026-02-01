/**
 * 可扩展 Skills 系统
 *
 * OpenClaw 的 Skills 系统:
 * - SKILL.md 定义技能 (frontmatter + prompt)
 * - 支持参数、触发条件、安装脚本
 * - 动态加载和卸载
 *
 * 这里简化为: 基于文件的技能定义 + 运行时注入
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface Skill {
  /** 技能 ID */
  id: string;
  /** 技能名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 触发关键词 */
  triggers?: string[];
  /** 技能 Prompt */
  prompt: string;
  /** 来源 */
  source: "builtin" | "workspace" | "user";
}

export interface SkillMatch {
  skill: Skill;
  matchedTrigger?: string;
}

const SKILL_DIR_NAMES = [".mini-agent/skills", "skills"];

export class SkillManager {
  private workspaceDir: string;
  private userDir: string;
  private skills: Map<string, Skill> = new Map();
  private loaded = false;

  constructor(workspaceDir: string, userDir: string = "~/.mini-agent") {
    this.workspaceDir = workspaceDir;
    this.userDir = userDir.replace("~", process.env.HOME || "");
  }

  /**
   * 加载所有技能
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;

    // 1. 加载内置技能
    this.registerBuiltinSkills();

    // 2. 加载用户全局技能 (~/.mini-agent/skills/)
    for (const dirName of SKILL_DIR_NAMES) {
      await this.loadFromDir(path.join(this.userDir, dirName), "user");
    }

    // 3. 加载工作空间技能 (./skills/ 或 ./.mini-agent/skills/)
    for (const dirName of SKILL_DIR_NAMES) {
      await this.loadFromDir(path.join(this.workspaceDir, dirName), "workspace");
    }

    this.loaded = true;
  }

  /**
   * 注册内置技能
   */
  private registerBuiltinSkills(): void {
    const builtins: Skill[] = [
      {
        id: "code-review",
        name: "代码审查",
        description: "审查代码质量、安全性和最佳实践",
        triggers: ["/review", "review code", "代码审查"],
        prompt: `你正在进行代码审查。请检查:
1. 代码质量和可读性
2. 潜在的 bug 和边界情况
3. 安全漏洞
4. 性能问题
5. 最佳实践遵循

提供具体的改进建议，不要泛泛而谈。`,
        source: "builtin",
      },
      {
        id: "explain",
        name: "代码解释",
        description: "解释代码逻辑和实现原理",
        triggers: ["/explain", "explain this", "解释"],
        prompt: `你正在解释代码。请:
1. 概述整体功能
2. 解释关键逻辑流程
3. 说明重要的数据结构
4. 指出值得注意的设计模式

用简洁清晰的语言，假设读者有基础编程知识。`,
        source: "builtin",
      },
      {
        id: "refactor",
        name: "代码重构",
        description: "重构代码以提高可维护性",
        triggers: ["/refactor", "refactor", "重构"],
        prompt: `你正在重构代码。原则:
1. 保持功能不变
2. 提高可读性
3. 减少重复
4. 改善命名
5. 简化复杂逻辑

每次修改要说明理由，确保测试通过。`,
        source: "builtin",
      },
      {
        id: "test",
        name: "编写测试",
        description: "为代码编写单元测试",
        triggers: ["/test", "write test", "测试"],
        prompt: `你正在编写测试。请:
1. 覆盖正常路径
2. 覆盖边界情况
3. 覆盖错误处理
4. 使用清晰的测试命名

使用项目已有的测试框架风格。`,
        source: "builtin",
      },
    ];

    for (const skill of builtins) {
      this.skills.set(skill.id, skill);
    }
  }

  /**
   * 从目录加载技能
   */
  private async loadFromDir(dir: string, source: Skill["source"]): Promise<void> {
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dir, file);
        const skill = await this.parseSkillFile(filePath, source);
        if (skill) {
          this.skills.set(skill.id, skill);
        }
      }
    } catch {
      // 目录不存在，忽略
    }
  }

  /**
   * 解析技能文件 (SKILL.md 格式)
   *
   * 格式:
   * ---
   * id: my-skill
   * name: 我的技能
   * triggers: ["/myskill", "触发词"]
   * ---
   *
   * Prompt 内容...
   */
  private async parseSkillFile(
    filePath: string,
    source: Skill["source"],
  ): Promise<Skill | null> {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

      if (!frontmatterMatch) {
        // 无 frontmatter，使用文件名作为 ID
        const id = path.basename(filePath, ".md").toLowerCase();
        return {
          id,
          name: id,
          description: "",
          prompt: content.trim(),
          source,
        };
      }

      const [, frontmatter, prompt] = frontmatterMatch;
      const meta: Record<string, unknown> = {};

      // 简单解析 YAML frontmatter
      for (const line of frontmatter.split("\n")) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) {
          const [, key, value] = match;
          // 尝试解析数组
          if (value.startsWith("[") && value.endsWith("]")) {
            try {
              meta[key] = JSON.parse(value.replace(/'/g, '"'));
            } catch {
              meta[key] = value;
            }
          } else {
            meta[key] = value.replace(/^["']|["']$/g, "");
          }
        }
      }

      const id = (meta.id as string) || path.basename(filePath, ".md").toLowerCase();
      return {
        id,
        name: (meta.name as string) || id,
        description: (meta.description as string) || "",
        triggers: meta.triggers as string[] | undefined,
        prompt: prompt.trim(),
        source,
      };
    } catch {
      return null;
    }
  }

  /**
   * 根据输入匹配技能
   */
  async match(input: string): Promise<SkillMatch | null> {
    await this.loadAll();

    const lower = input.toLowerCase().trim();

    for (const skill of this.skills.values()) {
      if (!skill.triggers) continue;

      for (const trigger of skill.triggers) {
        if (lower.startsWith(trigger.toLowerCase())) {
          return { skill, matchedTrigger: trigger };
        }
      }
    }

    return null;
  }

  /**
   * 获取技能
   */
  async get(id: string): Promise<Skill | null> {
    await this.loadAll();
    return this.skills.get(id) || null;
  }

  /**
   * 列出所有技能
   */
  async list(): Promise<Skill[]> {
    await this.loadAll();
    return Array.from(this.skills.values());
  }

  /**
   * 注册自定义技能
   */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /**
   * 构建技能描述 (注入系统提示)
   */
  async buildSkillsPrompt(): Promise<string> {
    const skills = await this.list();
    if (skills.length === 0) return "";

    const lines = skills.map((s) => {
      const triggers = s.triggers ? ` (${s.triggers.join(", ")})` : "";
      return `- **${s.name}**${triggers}: ${s.description}`;
    });

    return `\n\n## 可用技能\n\n${lines.join("\n")}`;
  }
}
