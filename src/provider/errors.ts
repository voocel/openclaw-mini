/**
 * Provider 错误分类与重试
 *
 * 对应 OpenClaw:
 * - src/agents/failover-error.ts → FailoverError 类
 * - src/agents/pi-embedded-helpers/errors.ts → 错误模式匹配
 * - src/infra/retry.ts → retryAsync() 指数退避
 *
 * 设计:
 * - 错误分类: 将 LLM API 错误归入有限类别，决定重试策略
 * - 指数退避: 避免在限速/过载时疯狂重试
 * - Context Overflow: 单独处理，触发自动 compact 而非简单重试
 */

// ============== 错误分类 ==============

/**
 * Failover 原因
 *
 * 对应 OpenClaw: pi-embedded-helpers/errors.ts → FailoverReason
 */
export type FailoverReason =
  | "rate_limit"
  | "auth"
  | "timeout"
  | "billing"
  | "format"
  | "unknown";

/**
 * FailoverError — 带分类信息的错误
 *
 * 对应 OpenClaw: failover-error.ts → FailoverError
 * - 携带错误原因、provider、model 等元数据
 * - 上层可根据 reason 决定重试/切换/放弃
 */
export class FailoverError extends Error {
  readonly reason: FailoverReason;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;

  constructor(
    message: string,
    params: {
      reason: FailoverReason;
      provider?: string;
      model?: string;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: params.cause });
    this.name = "FailoverError";
    this.reason = params.reason;
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
  }
}

export function isFailoverError(err: unknown): err is FailoverError {
  return err instanceof FailoverError;
}

// ============== 错误模式匹配 ==============

/**
 * 对应 OpenClaw: pi-embedded-helpers/errors.ts 中的各种 isXxxErrorMessage
 */

const RATE_LIMIT_PATTERNS = [
  "rate_limit",
  "too many requests",
  "429",
  "exceeded quota",
  "resource exhausted",
  "quota exceeded",
  "resource_exhausted",
  "usage limit",
];

const TIMEOUT_PATTERNS = [
  "timeout",
  "timed out",
  "deadline exceeded",
  "context deadline exceeded",
];

const AUTH_PATTERNS = [
  "invalid_api_key",
  "incorrect api key",
  "invalid token",
  "authentication",
  "unauthorized",
  "forbidden",
  "access denied",
  "expired",
  "401",
  "403",
];

const BILLING_PATTERNS = [
  "402",
  "payment required",
  "insufficient credits",
  "credit balance",
];

const FORMAT_PATTERNS = [
  "string should match pattern",
  "invalid request format",
];

const CONTEXT_OVERFLOW_PATTERNS = [
  "request_too_large",
  "request exceeds the maximum size",
  "context length exceeded",
  "maximum context length",
  "prompt is too long",
  "exceeds model context window",
  "context overflow",
];

function matchesAny(message: string, patterns: string[]): boolean {
  const lower = message.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/**
 * Context Overflow 检测
 *
 * 对应 OpenClaw: pi-embedded-helpers/errors.ts → isContextOverflowError()
 * - 与普通 failover 分开处理
 * - 触发 auto-compact 而非简单重试
 */
export function isContextOverflowError(message?: string): boolean {
  if (!message) return false;
  if (matchesAny(message, CONTEXT_OVERFLOW_PATTERNS)) return true;
  // 413 + "too large" 组合
  const lower = message.toLowerCase();
  if (lower.includes("413") && lower.includes("too large")) return true;
  return false;
}

export function isRateLimitError(message?: string): boolean {
  return !!message && matchesAny(message, RATE_LIMIT_PATTERNS);
}

export function isTimeoutError(message?: string): boolean {
  return !!message && matchesAny(message, TIMEOUT_PATTERNS);
}

export function isAuthError(message?: string): boolean {
  return !!message && matchesAny(message, AUTH_PATTERNS);
}

/**
 * 分类错误原因
 *
 * 对应 OpenClaw: pi-embedded-helpers/errors.ts → classifyFailoverReason()
 * - 按优先级匹配: billing > auth > rate_limit > timeout > format > null
 */
export function classifyFailoverReason(message: string): FailoverReason | null {
  if (matchesAny(message, BILLING_PATTERNS)) return "billing";
  if (matchesAny(message, AUTH_PATTERNS)) return "auth";
  if (matchesAny(message, RATE_LIMIT_PATTERNS)) return "rate_limit";
  if (matchesAny(message, TIMEOUT_PATTERNS)) return "timeout";
  if (matchesAny(message, FORMAT_PATTERNS)) return "format";
  return null;
}

/**
 * 判断错误是否值得触发 failover（切换 profile / model）
 *
 * 对应 OpenClaw: isFailoverErrorMessage()
 */
export function isFailoverErrorMessage(message?: string): boolean {
  if (!message) return false;
  const reason = classifyFailoverReason(message);
  // timeout 不触发 failover（可能只是网络抖动）
  return reason !== null && reason !== "timeout";
}

// ============== 指数退避重试 ==============

/**
 * 重试配置
 *
 * 对应 OpenClaw: src/infra/retry.ts → RetryOptions
 */
export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  attempts?: number;
  /** 最小延迟（默认 300ms） */
  minDelayMs?: number;
  /** 最大延迟（默认 30000ms） */
  maxDelayMs?: number;
  /** 抖动系数 0-1（默认 0.1） */
  jitter?: number;
  /** 日志标签 */
  label?: string;
  /** 是否应该重试（返回 false 则直接抛出） */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** 重试回调 */
  onRetry?: (info: { attempt: number; delay: number; error: unknown }) => void;
}

/**
 * 带指数退避的异步重试
 *
 * 对应 OpenClaw: src/infra/retry.ts → retryAsync()
 *
 * 退避公式: delay = minDelayMs * 2^(attempt-1)
 * 加抖动:   delay *= (1 + random(-jitter, +jitter))
 * 上下界:   clamp(minDelayMs, maxDelayMs)
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const minDelayMs = options?.minDelayMs ?? 300;
  const maxDelayMs = options?.maxDelayMs ?? 30_000;
  const jitter = options?.jitter ?? 0.1;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === attempts) break;
      if (options?.shouldRetry && !options.shouldRetry(err, attempt)) break;

      // 指数退避
      let delay = minDelayMs * 2 ** (attempt - 1);

      // 抖动
      if (jitter > 0) {
        const offset = (Math.random() * 2 - 1) * jitter;
        delay *= 1 + offset;
      }

      // 上下界
      delay = Math.max(Math.min(delay, maxDelayMs), minDelayMs);

      options?.onRetry?.({ attempt, delay, error: err });

      await sleep(delay);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============== 描述错误 ==============

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
