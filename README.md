# OpenClaw Mini

**OpenClaw 核心架构的精简复现，用于学习 AI Agent 的系统级设计。**

> "没有记忆的 AI 只是函数映射，有记忆 + 主动唤醒的 AI，才是会演化的'生命系统'"

## 项目定位

目标：

- 用一个小而完整的项目解释 OpenClaw 内核真正重要的设计点
- 让读者能同时读懂 CLI、Agent Loop、Session、Context、Gateway 四条主线
- 保留“为什么这么设计”的注释，而不只是给出能跑的代码

非目标：

- 不追求和 OpenClaw 主仓库 1:1 API 兼容
- 不覆盖所有 channel、provider、插件和运维能力
- 不把生产环境里的所有防护、权限和兼容性细节都搬过来

仓库：

- GitHub: `https://github.com/voocel/openclaw-mini`
- npm 包名: `openclaw-mini`

## 20 分钟快速开始

```bash
git clone git@github.com:voocel/openclaw-mini.git
cd openclaw-mini
pnpm install
cp .env.example .env
```

在 `.env` 里至少配置一个可用的模型 Key，然后先跑最小校验：

```bash
pnpm test
pnpm dev
```

想直接看 Gateway 的 ACK-then-stream 链路：

```bash
pnpm example:gateway
```

## 安装与开发

作为独立项目开发：

```bash
pnpm install
pnpm test
pnpm build
```

本地 CLI：

```bash
pnpm dev
pnpm gateway
pnpm gateway:connect
```

发布前自检：

```bash
pnpm test
pnpm build
pnpm pack:check
```

## 为什么做这个项目

网上大多数 Agent 教程只讲 Agent Loop：

```python
while tool_calls:
    response = llm.generate(messages)
    for tool in tools:
        result = tool.execute()
        messages.append(result)
```

**这不是真正的 Agent 架构。** 一个生产级 Agent 需要的是"系统级最佳实践"。

OpenClaw 是一个超 43w 行的复杂 Agent 系统，本项目从中提炼出核心设计与最小实现，帮助你理解：

- Agent Loop 的双层循环与 EventStream 事件流
- 会话持久化与上下文管理（裁剪 + 摘要压缩）
- 长期记忆、技能系统、主动唤醒的真实实现
- 多 Provider 适配（Anthropic / OpenAI / Google / Groq 等 22+ 提供商）

## 模块分层

本项目按学习价值分为四层，建议按 **核心 → 扩展 → 网关 → 工程** 的顺序阅读：

```
┌─────────────────────────────────────────────────────────────┐
│                     [网关层] Gateway                          │
│  WebSocket RPC 网关，让 Agent 从 CLI 直连升级为网络服务       │
│                                                              │
│  Protocol (帧协议)  · Server (广播+握手+路由)                │
│  Client (重连+心跳) · Handlers (RPC 方法)                    │
├─────────────────────────────────────────────────────────────┤
│                     [工程层] Production                      │
│  生产级防护与控制，学习可跳过                                 │
│                                                              │
│  session-key · tool-policy · command-queue                   │
│  sandbox-paths · context-window-guard · tool-result-guard    │
├─────────────────────────────────────────────────────────────┤
│                     [扩展层] Extended                         │
│  openclaw 特有的高级功能，非通用 Agent 必需                   │
│                                                              │
│  Memory (长期记忆) · Skills (技能系统) · Heartbeat (主动唤醒) │
├─────────────────────────────────────────────────────────────┤
│                    [渠道层] Channels                          │
│  多渠道机器人接入，支持飞书、Webhook 等                      │
│                                                              │
│  Feishu (飞书) · Webhook · Example · Channel Manager        │
├─────────────────────────────────────────────────────────────┤
│                      [核心层] Core                            │
│  任何 Agent 都需要的基础能力 ← 优先阅读                      │
│                                                              │
│  Agent Loop (双层循环)     EventStream (20 种类型化事件)      │
│  Session (JSONL 持久化)    Context (加载 + 裁剪 + 摘要压缩)  │
│  Tools (工具抽象+内置)     Provider (多模型适配)              │
└─────────────────────────────────────────────────────────────┘
```

### 核心层 — 必读

| 模块 | 文件 | 核心职责 | openclaw 对应 |
|------|------|----------|---------------|
| **Agent** | `agent.ts` | 入口 + subscribe/emit 事件分发 | `agent.js` |
| **Agent Loop** | `agent-loop.ts` | 双层循环 (outer=follow-up, inner=tools+steering) | `agent-loop.js` |
| **EventStream** | `agent-events.ts` | 20 种 MiniAgentEvent 判别联合 + 异步推拉 | `types.d.ts` AgentEvent |
| **Session** | `session.ts` | JSONL 持久化、历史管理 | `session-manager.ts` |
| **Context** | `context/loader.ts` | 按需加载 AGENTS.md 等 bootstrap 文件 | `bootstrap-files.ts` |
| **Pruning** | `context/pruning.ts` | 三层递进裁剪 (tool_result → assistant → 保留最近) | `context-pruning/pruner.ts` |
| **Compaction** | `context/compaction.ts` | 自适应分块摘要压缩 | `compaction.ts` |
| **Tools** | `tools/*.ts` | 工具抽象 + 10 个内置工具 | `src/tools/` |
| **Provider** | `provider/*.ts` | 多模型适配层 (基于 pi-ai, 22+ 提供商) | `pi-ai` |

### 扩展层 — 选读

| 模块 | 文件 | 核心职责 | openclaw 对应 |
|------|------|----------|---------------|
| **Memory** | `memory.ts` | 长期记忆 (关键词检索 + 相关性排序) | `memory/manager.ts` |
| **Skills** | `skills.ts` | SKILL.md frontmatter + 触发词匹配 | `agents/skills/` |
| **Heartbeat** | `heartbeat.ts` | 两层架构: wake 请求合并 + runner 调度 | `heartbeat-runner.ts` + `heartbeat-wake.ts` |

### 渠道层 — 机器人接入

| 模块 | 文件 | 核心职责 | 支持渠道 |
|------|------|----------|----------|
| **Channels** | `channels/*.ts` | 多渠道机器人接入与管理 | 飞书、Webhook、示例 |
| **Feishu** | `channels/feishu.ts` | 飞书机器人集成 | 企业自建应用 |
| **Webhook** | `channels/webhook.ts` | 通用 Webhook 支持 | HTTP/HTTPS |
| **Channel Tools** | `tools/channel.ts` | 渠道相关工具 | channel_send, channel_status, channel_broadcast |

### 工程层 — 可跳过

| 模块 | 文件 | 核心职责 |
|------|------|----------|
| **Session Key** | `session-key.ts` | 多 agent 会话键规范化 (`agent:id:session`) |
| **Tool Policy** | `tool-policy.ts` | 工具访问三级控制 (allow/deny/none) |
| **Command Queue** | `command-queue.ts` | 并发 lane 控制 (session 串行 + global 并行) |
| **Tool Result Guard** | `session-tool-result-guard.ts` | 自动补齐缺失的 tool_result |
| **Context Window Guard** | `context-window-guard.ts` | 上下文窗口溢出保护 |
| **Sandbox Paths** | `sandbox-paths.ts` | 路径安全检查 |

### 网关层 — 进阶必读

学习如何将 Agent 从 CLI 直连升级为可远程访问的 WebSocket RPC 服务。

| 模块 | 文件 | 核心职责 | openclaw 对应 |
|------|------|----------|---------------|
| **Protocol** | `gateway/protocol.ts` | 三种帧类型 (req/res/event) + 错误码 + 常量 | `protocol/schema/frames.ts` + `error-codes.ts` |
| **Server** | `gateway/server.ts` | HTTP+WS 服务、challenge 握手、方法路由、Pub/Sub 广播、背压控制、优雅关闭 | `server.impl.ts` + `server-broadcast.ts` + `server-close.ts` |
| **Handlers** | `gateway/handlers.ts` | 6 个 RPC 方法 (connect/chat.send/chat.history/sessions.*/health) | `server-methods/*.ts` |
| **Client** | `gateway/client.ts` | Pending Map、指数退避重连、Tick 心跳监视、seq 间隙检测 | `client.ts` |
| **CLI** | `gateway/gateway-cli.ts` | serve/connect 双模式 CLI 入口 | `cli/gateway-cli.ts` |

---

## 核心设计解析

### 1. Agent Loop — 双层循环 + EventStream

**问题**：简单 while 循环无法处理 follow-up、steering injection、上下文溢出等复杂场景。

**openclaw 方案**：双层循环 + EventStream 事件流

```typescript
// agent-loop.ts — 返回 EventStream，IIFE 推送事件
function runAgentLoop(params): EventStream<MiniAgentEvent, MiniAgentResult> {
  const stream = createMiniAgentStream();

  (async () => {
    // outer loop: follow-up 循环（处理 end_turn / tool_use 继续）
    while (outerTurn < maxOuterTurns) {
      // inner loop: 工具执行 + steering injection
      // stream.push({ type: "tool_execution_start", ... })
    }
    stream.end({ text, turns, toolCalls });
  })();

  return stream;  // 调用方 for-await 消费
}
```

**事件订阅**（对齐 pi-agent-core `Agent.subscribe`）：

```typescript
const agent = new Agent({ apiKey, provider: "anthropic" });

const unsubscribe = agent.subscribe((event) => {
  switch (event.type) {
    case "message_delta":  // 流式文本
      process.stdout.write(event.delta);
      break;
    case "tool_execution_start":  // 工具开始
      console.log(`[${event.toolName}]`, event.args);
      break;
    case "agent_error":  // 运行错误
      console.error(event.error);
      break;
  }
});

const result = await agent.run(sessionKey, "列出当前目录的文件");
unsubscribe();
```

### 2. Session Manager — JSONL 持久化

**问题**：Agent 重启后如何恢复对话上下文？

```typescript
// session.ts — 双写策略: 内存缓存 + 磁盘持久化
async append(sessionKey: string, message: Message): Promise<void> {
  // 1. 内存缓存立即更新（读取零 I/O）
  state.entries.push(entry);

  // 2. 首条 assistant 消息后才落盘（避免空会话写磁盘）
  if (!state.hasAssistant && message.role === "assistant") {
    state.hasAssistant = true;
    await rewriteSessionFile(state); // 首次: 完整写入 header + entries
  } else if (state.hasAssistant) {
    await fs.appendFile(filePath, line); // 后续: O(1) 追加
  }
}
```

JSONL 格式：每行一条 entry，损坏行跳过不影响其他数据。写锁防并发。

### 3. Context — 加载 + 裁剪 + 摘要压缩

**问题**：上下文窗口有限，如何在不丢失关键信息的情况下控制大小？

三层递进策略：
1. **Pruning** — 裁剪旧的 tool_result（保留最近 N 条完整）
2. **Compaction** — 超过阈值后，旧消息压缩为"历史摘要"
3. **Bootstrap** — 按需加载 AGENTS.md 等配置文件（超长文件 head+tail 截断）

### 4. Memory — 长期记忆 (扩展层)

**问题**：如何让 Agent "记住"跨会话的信息？

```typescript
// memory.ts — 关键词匹配 + 纯相关性排序（无时间衰减）
async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryTerms = query.toLowerCase().split(/\s+/);
  for (const entry of this.entries) {
    let score = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) score += 1;
      if (entry.tags.some(t => t.includes(term))) score += 0.5;
    }
  }
}
```

openclaw 用 SQLite-vec 做向量语义搜索 + BM25 关键词搜索，本项目简化为纯关键词相关性检索，不引入时间衰减。

### 5. Heartbeat — 主动唤醒 (扩展层)

**问题**：Agent 如何"主动"工作，而不只是被动响应？

两层架构：
- **HeartbeatWake**（请求合并层）：多来源触发 (interval/cron/exec/requested) → 250ms 合并窗口 → 双重缓冲
- **HeartbeatRunner**（调度层）：活跃时间检查 → HEARTBEAT.md 解析 → 空内容跳过 → 重复抑制

| 设计点 | 为什么这样做 |
|--------|-------------|
| setTimeout 而非 setInterval | 精确计算下次运行时间，避免漂移 |
| 250ms 合并窗口 | 防止多个事件同时触发 |
| 双重缓冲 | 运行中收到新请求不丢失 |
| 重复抑制 | 24h 内相同消息不重复发送 |

### 6. Gateway — WebSocket RPC 网关 (网关层)

**问题**：Agent 只能通过 CLI 本地使用，如何让多个客户端通过网络共享同一个 Agent？

**openclaw 方案**：WebSocket RPC + Pub/Sub 广播 + Challenge-Response 认证

```
终端 A ──┐                          ┌── broadcast ──→ 终端 A
         ├── WebSocket ──→ Gateway ──┤
终端 B ──┘       RPC       (Agent)  └── broadcast ──→ 终端 B
```

**12 个精华设计模式**（全部从 openclaw 源码提炼）：

| 设计模式 | 文件 | 对齐 openclaw |
|---------|------|--------------|
| 协议帧 (req/res/event 判别联合) | `protocol.ts` | `protocol/schema/frames.ts` |
| Challenge-Response 握手 | `server.ts` | `server/ws-connection.ts` |
| Timing-safe token 比较 | `handlers.ts` | `auth.ts` safeEqual |
| 方法路由 Handler Map | `handlers.ts` | `server-methods.ts` |
| Pub/Sub 广播 + seq 递增 | `server.ts` | `server-broadcast.ts` |
| `dropIfSlow` 分级背压 | `server.ts` | `server-broadcast.ts` |
| Delta 限流 (150ms) | `handlers.ts` | `server-chat.ts` emitChatDelta |
| Tick 心跳 30s | `server.ts` | `server-maintenance.ts` |
| Pending Map + 超时 + flush | `client.ts` | `client.ts` |
| Seq 间隙检测 | `client.ts` | `client.ts` onGap |
| 指数退避重连 (1s→30s) | `client.ts` | `client.ts` scheduleReconnect |
| Tick 心跳监视 (2 周期) | `client.ts` | `client.ts` startTickWatch |

**握手流程**：

```
Server                              Client
  │◄──── WebSocket 连接建立 ───────────│
  ├─ Event: connect.challenge ───────►│  { nonce, ts }
  │◄── Request: connect ─────────────┤  { token, nonce }
  ├── 验证 token (timingSafeEqual)     │
  ├─ Response: HelloOk ──────────────►│  { protocol, methods, events, policy }
```

**ACK-then-stream 模式**（聊天消息流转）：

```typescript
// 客户端发送
client.request("chat.send", { sessionKey: "main", message: "hello" });
// 服务端立即 ACK: { ok: true, payload: { sessionKey, runId } }
// 异步执行 agent.run()，事件流通过 broadcast 推送：
//   Event { event: "chat", payload: { state: "delta", text: "..." } }  ← 150ms 限流
//   Event { event: "chat", payload: { state: "final", text: "..." } }
```

---

## 设计模式索引

| 模式 | 所在文件 | 说明 |
|------|----------|------|
| EventStream 异步推拉 | `agent-events.ts` | push/asyncIterator/end/result |
| Subscribe/Emit 观察者 | `agent.ts` | listeners Set + subscribe 返回 unsubscribe |
| 双层循环 | `agent-loop.ts` | outer (follow-up) + inner (tools+steering) |
| JSONL 追加日志 | `session.ts` | 每行一条消息，追加写入 |
| 三层递进裁剪 | `context/pruning.ts` | tool_result → assistant → 保留最近 |
| 自适应分块摘要 | `context/compaction.ts` | 按 token 分块，逐块摘要 |
| 双重缓冲调度 | `heartbeat.ts` | running + scheduled 状态机 |
| 三级编译策略 | `tool-policy.ts` | allow/deny/none → 过滤工具列表 |
| Challenge-Response 握手 | `gateway/server.ts` | nonce 挑战 → token 验证 → HelloOk |
| Timing-safe 认证 | `gateway/handlers.ts` | crypto.timingSafeEqual 防计时攻击 |
| WebSocket RPC Pending Map | `gateway/client.ts` | UUID id → Promise → 超时自动 reject |
| Pub/Sub 广播 + 背压 | `gateway/server.ts` | seq 递增 + dropIfSlow + 慢消费者检测 |
| 指数退避重连 | `gateway/client.ts` | 1s → 2s → 4s → ... → 30s，成功后重置 |
| Tick 心跳监视 | `gateway/client.ts` | 2 周期无 tick → 主动断开触发重连 |
| Delta 限流 | `gateway/handlers.ts` | 150ms 内最多广播一次，累积文本 |
| ACK-then-stream | `gateway/handlers.ts` | 立即响应 → 异步执行 → 事件流推送 |

---

## 快速开始

要求：Node.js `>=20`

在项目根目录执行：

```bash
pnpm install
```

推荐用 `.env` 文件配置（项目启动时自动加载）：

```env
OPENCLAW_MINI_PROVIDER=anthropic
OPENCLAW_MINI_MODEL=claude-sonnet-4-20250514
OPENCLAW_MINI_BASE_URL=https://your-proxy.com/api/anthropic
ANTHROPIC_API_KEY=sk-xxx
```

```bash
pnpm dev
```

### 使用 OpenAI 兼容 API

智谱、DeepSeek、月之暗面 Kimi 等国产大模型均兼容 OpenAI 格式，通过 `provider=openai` + 自定义 `BASE_URL` 即可接入。

以智谱免费模型 GLM-4-Flash 为例：

```env
OPENCLAW_MINI_PROVIDER=openai
OPENCLAW_MINI_MODEL=glm-4-flash
OPENCLAW_MINI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
OPENCLAW_MINI_REASONING=none
OPENAI_API_KEY=你的API Key
```

```bash
pnpm dev
```

> `OPENCLAW_MINI_REASONING=none` 用于关闭 extended thinking，不支持该特性的模型需设置此项。

### Gateway 模式

除了 CLI 直连，还可以通过 Gateway 服务让多个客户端远程访问同一个 Agent：

```bash
# 终端 1：启动 Gateway 服务
pnpm gateway

# 终端 2：连接 Gateway
pnpm gateway:connect
```

可选参数：

```bash
pnpm gateway -- --port 8080 --token mySecret    # 自定义端口和认证 token
pnpm gateway:connect -- --url ws://remote:18789  # 连接远程 Gateway
pnpm gateway:connect -- --session work            # 指定会话名
```

客户端内命令：`/health` 查看状态、`/sessions` 列出会话、`/quit` 断开。

也支持 CLI 参数：

```bash
# 直接使用 Anthropic
ANTHROPIC_API_KEY=sk-xxx pnpm dev

# 指定 provider + model
pnpm dev -- --provider openai --model gpt-4o

# 使用代理
pnpm dev -- --base-url https://your-proxy.com/api/anthropic

# 关闭 extended thinking（不支持的模型需设置）
pnpm dev -- --reasoning none
```

## 使用示例

### 基础示例

```typescript
import { Agent } from "openclaw-mini";

const agent = new Agent({
  provider: "anthropic",
  baseUrl: "https://your-proxy.com/api/anthropic", // 可选，代理/自部署端点
  // apiKey 不传则自动从环境变量读取
  agentId: "main",
  workspaceDir: process.cwd(),
  reasoning: "medium", // 默认开启 extended thinking (minimal/low/medium/high/xhigh)
});

// 事件订阅
const unsubscribe = agent.subscribe((event) => {
  switch (event.type) {
    case "thinking_delta": // 流式思考
      process.stdout.write(event.delta);
      break;
    case "message_delta": // 流式文本
      process.stdout.write(event.delta);
      break;
    case "tool_execution_start":
      console.log(`[${event.toolName}]`, event.args);
      break;
  }
});

const result = await agent.run("session-1", "请列出当前目录的文件");
console.log(`${result.turns} 轮, ${result.toolCalls} 次工具调用`);

unsubscribe();
```

### 飞书渠道示例

```typescript
import { Agent, createChannelManager, FeishuChannel } from "openclaw-mini";

// 创建飞书渠道
const feishuChannel = new FeishuChannel("feishu-bot", {
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
});

// 创建渠道管理器
const channelManager = createChannelManager();
channelManager.registerChannel(feishuChannel);

// 初始化并连接
await feishuChannel.initialize();
await feishuChannel.connect();

// 创建 Agent
const agent = new Agent({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  workspaceDir: process.cwd(),
});

// 设置渠道管理器到 Agent 上下文
const sessionId = "feishu-session";
const context = await agent.getSessionContext(sessionId);
context.metadata = {
  ...context.metadata,
  channelManager,
};

// 使用渠道工具
const result = await agent.run(sessionId, "发送消息到飞书，内容：'你好，飞书！'，会话ID：oc_123456");
console.log(`消息发送结果: ${result.toolCalls} 次工具调用`);
```

更多示例请查看 `examples/` 目录：
- `basic.ts` - 基础使用
- `feishu-channel.ts` - 飞书渠道完整示例
- `custom-tools.ts` - 自定义工具示例

## 学习路径建议

1. **核心层优先**：`agent-loop.ts` → `agent.ts` → `agent-events.ts` → `session.ts` → `context/`
2. **理解事件流**：subscribe/emit 模式 + EventStream 异步推拉
3. **扩展层选读**：`memory.ts` → `skills.ts` → `heartbeat.ts`（按兴趣）
4. **网关层进阶**：`gateway/protocol.ts` → `gateway/server.ts` → `gateway/handlers.ts` → `gateway/client.ts`
5. **对照 openclaw 源码**：验证简化版是否抓住了核心
6. **工程层跳过**：除非你在做生产级 Agent，否则不需要关注

## License

MIT
