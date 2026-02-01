/**
 * 长期记忆系统
 *
 * OpenClaw 的记忆系统使用:
 * - 向量数据库 (SQLite-vec) 做语义搜索
 * - BM25 做关键词搜索
 * - 两者结果混合排序
 *
 * 这里简化为: 文件系统 + 关键词匹配 + 摘要索引
 */

import fs from "node:fs/promises";
import path from "node:path";

export interface MemoryEntry {
  id: string;
  content: string;
  source: "user" | "agent" | "system";
  tags: string[];
  createdAt: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  snippet: string;
}

export class MemoryManager {
  private baseDir: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(baseDir: string = "./.mini-agent/memory") {
    this.baseDir = baseDir;
  }

  private get indexPath(): string {
    return path.join(this.baseDir, "index.json");
  }

  /**
   * 加载记忆索引
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const content = await fs.readFile(this.indexPath, "utf-8");
      this.entries = JSON.parse(content);
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  /**
   * 保存记忆索引
   */
  private async save(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(this.indexPath, JSON.stringify(this.entries, null, 2));
  }

  /**
   * 添加记忆
   */
  async add(content: string, source: MemoryEntry["source"], tags: string[] = []): Promise<string> {
    await this.load();
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: MemoryEntry = {
      id,
      content,
      source,
      tags,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    await this.save();
    return id;
  }

  /**
   * 搜索记忆 (关键词匹配)
   */
  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.load();

    const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: MemorySearchResult[] = [];

    for (const entry of this.entries) {
      const text = entry.content.toLowerCase();
      let score = 0;

      // 关键词匹配得分
      for (const term of queryTerms) {
        if (text.includes(term)) {
          score += 1;
          // 标题/标签匹配额外加分
          if (entry.tags.some((t) => t.toLowerCase().includes(term))) {
            score += 0.5;
          }
        }
      }

      if (score > 0) {
        // 时间衰减: 越新的记忆分数越高
        const ageHours = (Date.now() - entry.createdAt) / (1000 * 60 * 60);
        const recencyBoost = Math.max(0, 1 - ageHours / (24 * 30)); // 30天衰减
        score += recencyBoost * 0.3;

        const snippet = entry.content.slice(0, 200);
        scored.push({ entry, score, snippet });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * 按 ID 读取记忆
   */
  async getById(id: string): Promise<MemoryEntry | null> {
    await this.load();
    const entry = this.entries.find((e) => e.id === id);
    return entry ?? null;
  }

  /**
   * 扫描 memory 目录下的 .md 文件 (类似 OpenClaw 的 memory files)
   */
  async syncFromFiles(): Promise<number> {
    await this.load();
    const memDir = path.join(this.baseDir, "files");

    try {
      const files = await fs.readdir(memDir);
      let synced = 0;

      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(memDir, file);
        const content = await fs.readFile(filePath, "utf-8");
        const existingIndex = this.entries.findIndex(
          (e) => e.tags.includes(`file:${file}`),
        );

        if (existingIndex >= 0) {
          this.entries[existingIndex].content = content;
        } else {
          await this.add(content, "system", [`file:${file}`]);
        }
        synced++;
      }

      await this.save();
      return synced;
    } catch {
      return 0;
    }
  }

  /**
   * 获取所有记忆 (用于调试)
   */
  async getAll(): Promise<MemoryEntry[]> {
    await this.load();
    return this.entries;
  }

  /**
   * 清空记忆
   */
  async clear(): Promise<void> {
    this.entries = [];
    await this.save();
  }
}
