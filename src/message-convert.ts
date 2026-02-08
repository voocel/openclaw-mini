/**
 * 消息格式转换: 内部 Message[] → pi-ai Message[]
 *
 * pi-ai 使用三种 role: "user" / "assistant" / "toolResult"
 * 内部格式: role 只有 "user" / "assistant"，tool_result 嵌在 user 消息的 content 中
 */

import type { Message } from "./session.js";
import type {
  Message as PiMessage,
  TextContent as PiTextContent,
  ToolCall as PiToolCall,
} from "@mariozechner/pi-ai";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 将内部 Message[] 转换为 pi-ai 的 Message[]
 *
 * 转换规则:
 * - user + string content → PiUserMessage
 * - user + ContentBlock[] 含 tool_result → 拆分为独立 PiToolResultMessage
 * - user + ContentBlock[] 含 text → PiUserMessage
 * - assistant + ContentBlock[] → PiAssistantMessage（tool_use → ToolCall）
 */
export function convertMessagesToPi(
  messages: Message[],
  modelInfo: { api: string; provider: string; id: string },
): PiMessage[] {
  const result: PiMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({
          role: "user",
          content: msg.content,
          timestamp: msg.timestamp,
        });
        continue;
      }

      const textParts: PiTextContent[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          textParts.push({ type: "text", text: block.text });
        } else if (block.type === "tool_result") {
          result.push({
            role: "toolResult",
            toolCallId: block.tool_use_id ?? "",
            toolName: block.name ?? "",
            content: [{ type: "text", text: typeof block.content === "string" ? block.content : "" }],
            isError: false,
            timestamp: msg.timestamp,
          });
        }
      }
      if (textParts.length > 0) {
        result.push({
          role: "user",
          content: textParts,
          timestamp: msg.timestamp,
        });
      }
    } else {
      // assistant
      if (typeof msg.content === "string") {
        result.push({
          role: "assistant",
          content: [{ type: "text", text: msg.content }],
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: msg.timestamp,
        });
        continue;
      }

      const piContent: (PiTextContent | PiToolCall)[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          piContent.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          piContent.push({
            type: "toolCall",
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: block.input ?? {},
          });
        }
      }

      result.push({
        role: "assistant",
        content: piContent,
        api: modelInfo.api,
        provider: modelInfo.provider,
        model: modelInfo.id,
        usage: EMPTY_USAGE,
        stopReason: "stop",
        timestamp: msg.timestamp,
      });
    }
  }

  return result;
}
