/**
 * 工具策略（简化版）
 *
 * 目标：为 mini 版提供最小的 allow/deny 控制能力，
 * 让“沙箱模式”与“按需开放工具”可演示。
 */

import type { Tool } from "./tools/types.js";

export type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

function compilePattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed || trimmed === "*") {
    return null;
  }
  if (!trimmed.includes("*")) {
    return new RegExp(`^${trimmed}$`);
  }
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = `^${escaped.replaceAll("\\*", ".*")}$`;
  return new RegExp(regex);
}

function matchesPattern(name: string, pattern: string): boolean {
  const normalized = normalizeToolName(name);
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "*") {
    return true;
  }
  const compiled = compilePattern(trimmed);
  return compiled ? compiled.test(normalized) : false;
}

export function isToolAllowed(name: string, policy?: ToolPolicy): boolean {
  if (!policy) {
    return true;
  }
  const deny = policy.deny ?? [];
  const allow = policy.allow ?? [];

  for (const pattern of deny) {
    if (matchesPattern(name, pattern)) {
      return false;
    }
  }

  if (allow.length === 0) {
    return true;
  }

  return allow.some((pattern) => matchesPattern(name, pattern));
}

export function filterToolsByPolicy(tools: Tool[], policy?: ToolPolicy): Tool[] {
  if (!policy) {
    return tools;
  }
  return tools.filter((tool) => isToolAllowed(tool.name, policy));
}

export function mergeToolPolicies(base?: ToolPolicy, extra?: ToolPolicy): ToolPolicy | undefined {
  if (!base && !extra) {
    return undefined;
  }
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
