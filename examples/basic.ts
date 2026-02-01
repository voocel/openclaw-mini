/**
 * 基础使用示例
 */

import { Agent } from "../src/index.js";

async function main() {
  const agent = new Agent({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceDir: process.cwd(),
  });

  const sessionId = "example-basic";

  console.log("Mini Agent 基础示例\n");

  // 示例 1: 简单对话
  console.log("--- 示例 1: 列出文件 ---");
  const result1 = await agent.run(sessionId, "列出当前目录的文件", {
    onTextDelta: (d) => process.stdout.write(d),
    onToolStart: (name) => console.log(`\n[调用工具: ${name}]`),
  });
  console.log(`\n完成: ${result1.turns} 轮, ${result1.toolCalls} 次工具调用\n`);

  // 示例 2: 代码操作
  console.log("--- 示例 2: 读取 package.json ---");
  const result2 = await agent.run(sessionId, "读取 package.json 并告诉我项目名称", {
    onTextDelta: (d) => process.stdout.write(d),
    onToolStart: (name) => console.log(`\n[调用工具: ${name}]`),
  });
  console.log(`\n完成: ${result2.turns} 轮\n`);

  // 清理会话
  await agent.reset(sessionId);
}

main().catch(console.error);
