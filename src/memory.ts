/**
 * 长期记忆系统
 *
 * 对应 OpenClaw 源码:
 * - src/memory/manager.ts — MemoryIndexManager (索引 + 搜索编排)
 * - src/memory/manager-search.ts — searchVector() / searchKeyword() 实现
 * - src/memory/memory-schema.ts — SQLite schema (chunks / chunks_fts / chunks_vec)
 * - src/memory/hybrid.ts — mergeHybridResults() 混合评分
 * - src/memory/internal.ts — chunkMarkdown() 分块
 *
 * OpenClaw 真实架构:
 * - 存储: SQLite (chunks 表 + FTS5 全文索引 + sqlite-vec 向量索引)
 * - 搜索: BM25 关键词搜索 + 余弦相似度向量搜索 → 加权混合
 * - 分块: Markdown 按行分块 (token 限制 + overlap)
 * - 来源: "memory" (MEMORY.md / memory/*.md) 和 "sessions" (会话记录)
 * - 无时间衰减: 排序完全基于语义/关键词相关性，不考虑时间远近
 *
 * Mini 简化:
 * - 存储: 文件系统 JSON 索引（替代 SQLite）
 * - 搜索: BM25 风格词频评分（替代 FTS5 + 向量搜索）
 * - 分块: 整条存储（省略 chunkMarkdown 分块策略）
 * - 来源: 仅 "memory"（省略 sessions 索引）
 *
 * 保留的核心设计:
 * - 纯相关性排序（无时间衰减，对齐 openclaw）
 * - source 来源标识
 * - hash 去重检测
 * - search + save 双 API
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ============== 类型 ==============

/**
 * 记忆来源
 *
 * 对应 OpenClaw: MemorySource
 * - memory: 来自 MEMORY.md 或 memory/*.md 文件
 * - sessions: 来自会话记录（mini 暂不实现）
 */
export type MemorySource = "memory" | "sessions";

/**
 * 记忆条目
 *
 * 对应 OpenClaw chunks 表的简化版:
 * - id: 唯一标识（内容 hash 生成，用于去重）
 * - content: 原始文本内容
 * - source: 数据来源标识
 * - path: 来源文件路径（对应 openclaw chunks.path）
 * - hash: 内容 hash（对应 openclaw chunks.hash，用于变更检测）
 * - createdAt: 创建时间（仅用于元数据，不参与搜索排序）
 */
export interface MemoryEntry {
  id: string;
  content: string;
  source: MemorySource;
  path?: string;
  hash: string;
  createdAt: number;
}

/**
 * 搜索结果
 *
 * 对应 OpenClaw: MemorySearchResult
 * score 完全基于关键词相关性（无时间衰减）
 */
export interface MemorySearchResult {
  entry: MemoryEntry;
  /** 相关性得分 (纯关键词/语义匹配，不含时间因素) */
  score: number;
  /** 内容片段 (用于预览) */
  snippet: string;
}

// ============== 搜索算法 ==============

/**
 * BM25 风格的关键词评分
 *
 * 对应 OpenClaw: FTS5 BM25 + bm25RankToScore()
 *
 * 真正的 BM25 需要倒排索引和 IDF 统计，这里用简化版本:
 * - 词频 (TF): term 在文档中的出现次数
 * - 文档长度归一化: 短文档中的匹配权重更高
 * - 查询覆盖率: 匹配的查询词比例
 *
 * 关键: 无时间衰减，对齐 openclaw 的设计决策
 */
function computeKeywordScore(
  content: string,
  queryTerms: string[],
): number {
  if (queryTerms.length === 0) return 0;

  const text = content.toLowerCase();
  const docLength = text.length;
  // 避免除零，给极短文档一个最小长度
  const normalizedLength = Math.max(docLength, 1);

  let matchedTerms = 0;
  let totalTf = 0;

  for (const term of queryTerms) {
    // 统计词频
    let tf = 0;
    let pos = 0;
    while (true) {
      const idx = text.indexOf(term, pos);
      if (idx === -1) break;
      tf += 1;
      pos = idx + term.length;
    }

    if (tf > 0) {
      matchedTerms += 1;
      // BM25 风格饱和: tf / (tf + k1)，避免高频词过度加分
      const k1 = 1.2;
      const saturatedTf = tf / (tf + k1);
      totalTf += saturatedTf;
    }
  }

  if (matchedTerms === 0) return 0;

  // 查询覆盖率: 匹配了多少查询词
  const coverage = matchedTerms / queryTerms.length;

  // 文档长度惩罚: 较短文档中的匹配更有价值
  const avgDocLength = 500; // 假设平均文档长度
  const b = 0.75; // BM25 的 b 参数
  const lengthPenalty = 1 - b + b * (normalizedLength / avgDocLength);

  // 最终得分: 覆盖率 * 词频 / 长度惩罚
  return (coverage * totalTf) / lengthPenalty;
}

/**
 * 提取查询词
 *
 * 对应 OpenClaw manager-search.ts: buildFtsQuery()
 * 提取字母数字 token（与 FTS5 的 tokenizer 对齐）
 */
function extractQueryTerms(query: string): string[] {
  const tokens = query.toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [];
  // 去重
  return [...new Set(tokens)];
}

// ============== MemoryManager ==============

export class MemoryManager {
  private baseDir: string;
  private entries: MemoryEntry[] = [];
  private loaded = false;

  constructor(baseDir: string = "./.openclaw-mini/memory") {
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
   * 计算内容 hash
   *
   * 对应 OpenClaw: hashText() 用于去重和变更检测
   */
  private hashContent(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  /**
   * 添加记忆
   *
   * 对应 OpenClaw: indexFile() 的简化版
   * - 使用 content hash 生成 ID（去重）
   * - 已存在相同 hash 的条目会更新而非重复添加
   */
  async add(
    content: string,
    source: MemorySource = "memory",
    filePath?: string,
  ): Promise<string> {
    await this.load();

    const hash = this.hashContent(content);
    const id = `mem_${hash}`;

    // Hash 去重: 内容相同则更新
    const existingIndex = this.entries.findIndex((e) => e.hash === hash);
    if (existingIndex >= 0) {
      this.entries[existingIndex].content = content;
      this.entries[existingIndex].path = filePath;
      await this.save();
      return this.entries[existingIndex].id;
    }

    const entry: MemoryEntry = {
      id,
      content,
      source,
      path: filePath,
      hash,
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    await this.save();
    return id;
  }

  /**
   * 搜索记忆
   *
   * 对应 OpenClaw: manager.search() → searchKeyword() + mergeHybridResults()
   *
   * 核心设计 (对齐 openclaw):
   * - 纯关键词相关性排序
   * - 无时间衰减（这是 openclaw 的明确设计决策）
   * - 结果按 score 降序，截断至 limit
   */
  async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.load();

    const queryTerms = extractQueryTerms(query);
    if (queryTerms.length === 0) return [];

    const scored: MemorySearchResult[] = [];

    for (const entry of this.entries) {
      const score = computeKeywordScore(entry.content, queryTerms);

      if (score > 0) {
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
    return this.entries.find((e) => e.id === id) ?? null;
  }

  /**
   * 扫描 memory 目录下的 .md 文件
   *
   * 对应 OpenClaw: indexFile() 的批量版
   * 使用 hash 检测变更，仅更新内容有变化的条目
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
        const hash = this.hashContent(content);

        // Hash 变更检测（对齐 openclaw 的 hash-based change detection）
        const existing = this.entries.find((e) => e.path === filePath);
        if (existing && existing.hash === hash) continue;

        await this.add(content, "memory", filePath);
        synced++;
      }

      return synced;
    } catch {
      return 0;
    }
  }

  /**
   * 获取所有记忆 (调试用)
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
