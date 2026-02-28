/**
 * 飞书渠道示例
 * 
 * 使用前需要：
 * 1. 在飞书开放平台创建企业自建应用
 * 2. 获取 App ID 和 App Secret
 * 3. 配置机器人权限
 * 4. 设置环境变量：
 *    - FEISHU_APP_ID
 *    - FEISHU_APP_SECRET
 *    - FEISHU_ENCRYPT_KEY (可选)
 *    - FEISHU_VERIFICATION_TOKEN (可选)
 */

import "dotenv/config";

import { Agent, createChannelManager, FeishuChannel } from "../src/index.js";

async function main() {
  console.log("飞书渠道示例\n");

  // 从环境变量获取配置
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
  const verificationToken = process.env.FEISHU_VERIFICATION_TOKEN;

  if (!appId || !appSecret) {
    console.error("错误：请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量");
    console.error("参考：https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-concepts");
    process.exit(1);
  }

  // 创建飞书渠道
  console.log("1. 创建飞书渠道...");
  const feishuChannel = new FeishuChannel("feishu-bot", {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
  });

  // 创建渠道管理器
  console.log("2. 创建渠道管理器...");
  const channelManager = createChannelManager();
  channelManager.registerChannel(feishuChannel);

  // 初始化并连接渠道
  console.log("3. 初始化飞书渠道...");
  try {
    await feishuChannel.initialize();
    await feishuChannel.connect();
    console.log("✅ 飞书渠道连接成功");
  } catch (error) {
    console.error("❌ 飞书渠道连接失败:", error);
    process.exit(1);
  }

  // 创建 Agent
  console.log("4. 创建 Agent...");
  const agent = new Agent({
    apiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceDir: process.cwd(),
  });

  // 设置渠道管理器到 Agent 上下文
  const sessionId = "feishu-example";
  // const context = await agent.getSessionContext(sessionId);
  // context.metadata = {
  //   ...context.metadata,
  //   channelManager,
  // };

  // 订阅事件
  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "message_delta":
        process.stdout.write(event.delta);
        break;
      case "tool_execution_start":
        console.log(`\n[调用工具: ${event.toolName}]`);
        break;
      case "tool_execution_end":
        console.log(`[工具结果: ${event.result.substring(0, 100)}${event.result.length > 100 ? '...' : ''}]`);
        break;
    }
  });

  console.log("\n5. 测试渠道功能...");

  // 示例 1: 查看渠道状态
  console.log("\n--- 示例 1: 查看渠道状态 ---");
  const result1 = await agent.run(sessionId, "查看所有渠道的状态");
  console.log(`\n完成: ${result1.turns} 轮对话`);

  // 示例 2: 发送测试消息到飞书
  console.log("\n--- 示例 2: 发送测试消息到飞书 ---");
  console.log("注意：需要提供飞书用户或群聊的 conversation_id");

  const conversationId = process.env.FEISHU_TEST_CONVERSATION_ID;
  if (conversationId) {
    const result2 = await agent.run(sessionId, `发送消息到飞书，内容："这是来自 Mini Agent 的测试消息，时间：${new Date().toLocaleString()}"，会话ID：${conversationId}`);
    console.log(`\n完成: ${result2.turns} 轮对话`);
  } else {
    console.log("跳过：请设置 FEISHU_TEST_CONVERSATION_ID 环境变量来测试消息发送");
  }

  // 示例 3: 广播消息
  console.log("\n--- 示例 3: 广播消息到所有渠道 ---");
  const result3 = await agent.run(sessionId, "广播消息到所有已连接的渠道，内容：'这是广播测试消息'");
  console.log(`\n完成: ${result3.turns} 轮对话`);

  // 示例 4: 处理飞书消息（模拟）
  console.log("\n--- 示例 4: 模拟处理飞书消息 ---");
  console.log("模拟飞书 webhook 事件...");

  // 模拟一个飞书消息事件
  const mockFeishuEvent = {
    event: {
      type: "message",
      message: {
        message_id: "mock_msg_123",
        chat_id: "oc_123456789",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "你好，Agent！" }),
        create_time: Math.floor(Date.now() / 1000).toString(),
        sender: {
          sender_id: {
            user_id: "u_123456",
            open_id: "ou_123456",
          },
        },
      },
    },
  };

  // 处理模拟事件
  try {
    await feishuChannel.handleWebhookEvent(mockFeishuEvent);
    console.log("✅ 模拟消息处理完成");
  } catch (error) {
    console.error("❌ 模拟消息处理失败:", error);
  }

  // 清理
  console.log("\n6. 清理资源...");
  unsubscribe();
  await feishuChannel.disconnect();
  await agent.reset(sessionId);

  console.log("\n✅ 示例完成");
}

// 运行示例
main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exit(1);
});