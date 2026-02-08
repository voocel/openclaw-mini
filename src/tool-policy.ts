/**
 * 工具策略
 *
 * 对应 OpenClaw: src/agents/pi-tools.policy.ts + src/agents/sandbox/tool-policy.ts
 *
 * 三级 CompiledPattern 设计:
 * - "all"   → "*" 匹配一切，短路返回
 * - "exact" → 无通配符，直接字符串比较，零 RegExp 开销
 * - "regex" → 含 * 通配符，编译为安全的 RegExp
 *
 * 转义链（仅 regex 分支）:
 *   1. 先把所有正则特殊字符转义: "exec*" → "exec\*"
 *   2. 再把 "\*"（被转义的通配符）替换为 ".*": "exec\*" → "exec.*"
 *   3. 加首尾锚点: "^exec.*$"
 *   效果: 用户输入的 . ( ) 等被当作字面量，只有 * 作为通配符
 */

import type { Tool } from "./tools/types.js";

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

// ============== 三级编译模式（对齐 OpenClaw） ==============

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 编译 pattern 为三级类型
 *
 * 对应 OpenClaw: pi-tools.policy.ts:11-32 → compilePattern()
 */
function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  // "*" → 匹配一切
  if (normalized === "*") {
    return { kind: "all" };
  }
  // 无通配符 → 精确匹配，不构造 RegExp
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  // 含通配符 → 安全编译为 RegExp
  // 步骤 1: 转义所有正则特殊字符（包括 *）
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 步骤 2: 把被转义的 \* 还原为 .* (通配符语义)
  const regex = `^${escaped.replaceAll("\\*", ".*")}$`;
  return { kind: "regex", value: new RegExp(regex) };
}

function compilePatterns(patterns: string[]): CompiledPattern[] {
  return patterns.map(compilePattern);
}

/**
 * 匹配已编译的 pattern 列表
 *
 * 对应 OpenClaw: pi-tools.policy.ts → matchesAny()
 */
function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && name === pattern.value) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

// ============== 公共 API ==============

/**
 * 判断工具是否被策略允许
 *
 * 对应 OpenClaw: makeToolPolicyMatcher() 的判定顺序:
 * 1. deny 优先 — 匹配 deny 则拒绝
 * 2. allow 为空 — 允许一切
 * 3. allow 匹配 — 明确允许
 * 4. 默认拒绝
 */
export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
  if (!policy) return true;

  const normalized = normalizeToolName(name);
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);

  if (matchesAny(normalized, deny)) return false;
  if (allow.length === 0) return true;
  return matchesAny(normalized, allow);
}

export function filterToolsByPolicy(tools: Tool[], policy?: ToolPolicy): Tool[] {
  if (!policy) return tools;
  // 预编译一次，避免 N 个工具重复编译 N 次
  const deny = compilePatterns(policy.deny ?? []);
  const allow = compilePatterns(policy.allow ?? []);
  return tools.filter((tool) => {
    const normalized = normalizeToolName(tool.name);
    if (matchesAny(normalized, deny)) return false;
    if (allow.length === 0) return true;
    return matchesAny(normalized, allow);
  });
}

export function mergeToolPolicies(base?: ToolPolicy, extra?: ToolPolicy): ToolPolicy | undefined {
  if (!base && !extra) return undefined;
  const allow = [
    ...(base?.allow ?? []),
    ...(extra?.allow ?? []),
  ].map((v) => v.trim()).filter(Boolean);
  const deny = [
    ...(base?.deny ?? []),
    ...(extra?.deny ?? []),
  ].map((v) => v.trim()).filter(Boolean);
  return {
    allow: allow.length > 0 ? Array.from(new Set(allow)) : undefined,
    deny: deny.length > 0 ? Array.from(new Set(deny)) : undefined,
  };
}
