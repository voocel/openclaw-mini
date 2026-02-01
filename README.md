# OpenClaw Mini

**OpenClaw 核心架构的极简复现，用于学习 AI Agent 的系统级设计。**

> "没有记忆的 AI 只是函数映射，有记忆 + 主动唤醒的 AI，才是会演化的'生命系统'"

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

OpenClaw 是一个 5 万行的生产级 Agent 系统，本项目从中提炼出 **~800 行核心代码**，帮助你理解：

- 为什么需要长期记忆？
- 如何实现按需上下文加载？
- 技能系统怎么设计才能扩展？
- 主动唤醒机制的真实实现是什么？

## 架构对照

```
┌──────────────────────────────────────────────────────────────────┐
│                       OpenClaw Mini                               │
│                      (本项目 ~800 行)                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐   │
│  │   Context   │  │   Skills    │  │       Heartbeat         │   │
│  │   Loader    │  │   Manager   │  │       Manager           │   │
│  │             │  │             │  │  ┌─────────────────┐    │   │
│  │ AGENT.md    │  │ SKILL.md    │  │  │ HeartbeatWake   │    │   │
│  │ HEARTBEAT.md│  │ 触发词匹配  │  │  │ (请求合并层)    │    │   │
│  │ CONTEXT.md  │  │ 内置+自定义 │  │  └────────┬────────┘    │   │
│  └──────┬──────┘  └──────┬──────┘  │           │             │   │
│         │                │         │  ┌────────▼────────┐    │   │
│         │                │         │  │ HeartbeatRunner │    │   │
│         │                │         │  │ (调度层)        │    │   │
│         │                │         │  └────────┬────────┘    │   │
│         │                │         └───────────┼─────────────┘   │
│         │                │                     │                  │
│         ▼                ▼                     ▼                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                      Agent Loop                             │  │
│  │                                                             │  │
│  │   while (tool_calls) {                                      │  │
│  │     response = llm.generate(system_prompt + messages)       │  │
│  │     for (tool of tools) { result = tool.execute() }         │  │
│  │     messages.push(result)                                   │  │
│  │   }                                                         │  │
│  │                                                             │  │
│  └────────────────────────────────────────────────────────────┘  │
│         │                                          │              │
│         ▼                                          ▼              │
│  ┌─────────────┐                          ┌─────────────┐        │
│  │   Session   │                          │   Memory    │        │
│  │   Manager   │                          │   Manager   │        │
│  │  (JSONL)    │                          │ (关键词检索) │        │
│  └─────────────┘                          └─────────────┘        │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

## 5 大核心子系统

| 子系统 | 本项目 | OpenClaw 源码 | 核心职责 |
|--------|--------|---------------|----------|
| **Session** | `session.ts` | `src/agents/session-manager.ts` | 会话持久化 (JSONL)、历史管理 |
| **Memory** | `memory.ts` | `src/memory/manager.ts` (76KB) | 长期记忆、语义检索 |
| **Context** | `context.ts` | `src/agents/bootstrap-files.ts` | 按需加载 CLAUDE.md/HEARTBEAT.md |
| **Skills** | `skills.ts` | `src/agents/skills/` | 可扩展技能、触发词匹配 |
| **Heartbeat** | `heartbeat.ts` | `src/infra/heartbeat-runner.ts`<br>`src/infra/heartbeat-wake.ts` | 主动唤醒、事件驱动调度 |

---

## 深入解析

### 1. Session Manager - 会话持久化

**问题**：Agent 重启后如何恢复对话上下文？

**OpenClaw 方案**：
- JSONL 格式存储（每行一条消息，追加写入）
- 分布式锁防止并发写入
- 自动 compaction 压缩历史

**本项目实现** (`session.ts:45-62`)：
```typescript
async append(sessionId: string, message: Message): Promise<void> {
  const filePath = this.getFilePath(sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(message) + "\n");
}
```

### 2. Memory Manager - 长期记忆

**问题**：如何让 Agent "记住"跨会话的信息？

**OpenClaw 方案** (`src/memory/manager.ts`)：
- SQLite-vec 向量数据库做语义搜索
- BM25 做关键词搜索
- 混合排序 (Hybrid Search)

**本项目简化** (`memory.ts:85-118`)：
```typescript
async search(query: string, limit = 5): Promise<MemorySearchResult[]> {
  const queryTerms = query.toLowerCase().split(/\s+/);

  for (const entry of this.entries) {
    let score = 0;
    // 关键词匹配得分
    for (const term of queryTerms) {
      if (text.includes(term)) score += 1;
      if (entry.tags.some(t => t.includes(term))) score += 0.5;
    }
    // 时间衰减：越新的记忆分数越高
    const recencyBoost = Math.max(0, 1 - ageHours / (24 * 30));
    score += recencyBoost * 0.3;
  }
}
```

### 3. Context Loader - 按需上下文

**问题**：如何注入项目级规范而不污染每次对话？

**OpenClaw 方案** (`src/agents/bootstrap-files.ts`)：
- `CLAUDE.md`：项目级长期规范
- `HEARTBEAT.md`：主动唤醒任务清单
- 层级加载：用户全局 → 工作空间 → .claude/ 目录

**本项目实现** (`context.ts:42-65`)：
```typescript
async loadAll(): Promise<ContextFile[]> {
  // 1. 加载用户全局配置 (~/.openclaw-mini/AGENT.md)
  // 2. 加载工作空间配置 (./AGENT.md)
  // 3. 加载 .openclaw-mini/ 目录配置
}
```

### 4. Skills Manager - 可扩展技能

**问题**：如何让用户自定义 Agent 能力？

**OpenClaw 方案** (`src/agents/skills/types.ts`)：
- SKILL.md frontmatter 定义元数据
- 支持触发条件、安装脚本、参数校验
- 运行时动态加载

**本项目实现** (`skills.ts:125-170`)：
```typescript
// SKILL.md 格式
// ---
// id: deploy
// name: 部署助手
// triggers: ["/deploy", "部署"]
// ---
// Prompt 内容...

async match(input: string): Promise<SkillMatch | null> {
  for (const skill of this.skills.values()) {
    for (const trigger of skill.triggers) {
      if (input.startsWith(trigger)) {
        return { skill, matchedTrigger: trigger };
      }
    }
  }
}
```

### 5. Heartbeat Manager - 主动唤醒

**问题**：Agent 如何"主动"工作，而不只是被动响应？

**OpenClaw 方案** (`src/infra/heartbeat-runner.ts`, `src/infra/heartbeat-wake.ts`)：

这是最复杂的子系统，包含两层架构：

```
┌─────────────────────────────────────────────────────────────┐
│                     HeartbeatWake (请求合并层)               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  多来源触发:                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ interval │  │   cron   │  │   exec   │  │ requested│    │
│  │ (定时器) │  │ (任务完成)│  │ (命令完成)│  │ (手动)   │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       │             │             │             │           │
│       └─────────────┴──────┬──────┴─────────────┘           │
│                            ▼                                 │
│                    request({ reason })                       │
│                            │                                 │
│                    ┌───────▼───────┐                        │
│                    │ 原因优先级合并 │                        │
│                    │ exec > cron   │                        │
│                    │ > interval    │                        │
│                    └───────┬───────┘                        │
│                            │                                 │
│                    ┌───────▼───────┐                        │
│                    │ schedule(250ms)│ ◄── 合并窗口          │
│                    └───────┬───────┘                        │
│                            │                                 │
│              ┌─────────────┼─────────────┐                  │
│              │ if running: │ else:       │                  │
│              │ scheduled=  │ setTimeout  │                  │
│              │ true (排队) │ execute()   │                  │
│              └─────────────┴─────────────┘                  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   HeartbeatRunner (调度层)                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  runOnce(request):                                          │
│                                                              │
│  1. isWithinActiveHours()  ─── 活跃时间窗口检查             │
│     │                          (08:00-22:00, 支持时区)      │
│     ▼                                                        │
│  2. parseTasks()           ─── HEARTBEAT.md 解析            │
│     │                                                        │
│     ▼                                                        │
│  3. 空内容检测             ─── 无任务时跳过 API 调用        │
│     │                          (exec 事件除外)              │
│     ▼                                                        │
│  4. 执行回调               ─── Agent 处理任务               │
│     │                                                        │
│     ▼                                                        │
│  5. isDuplicateMessage()   ─── 24h 内重复消息抑制           │
│     │                                                        │
│     ▼                                                        │
│  6. scheduleNext()         ─── setTimeout 精确调度          │
│                                (lastRunAt + intervalMs)     │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**关键设计决策**：

| 设计点 | 为什么这样做 |
|--------|-------------|
| setTimeout 而非 setInterval | 精确计算下次运行时间，避免漂移 |
| 250ms 合并窗口 | 防止多个事件同时触发导致的"呼吸急促" |
| 双重缓冲 | 运行中收到新请求不丢失，完成后立即处理 |
| 空内容检测 | 无任务时跳过 LLM 调用，节省成本 |
| 重复抑制 | 24h 内相同消息不重复发送，防止"纠缠" |
| 活跃时间窗口 | 避免半夜打扰用户 |

**本项目实现** (`heartbeat.ts:147-160`)：
```typescript
private schedule(delayMs: number): void {
  // 如果已在运行，标记为已排队（双重缓冲）
  if (this.state.running) {
    this.state.scheduled = true;
    return;
  }
  // 如果已有定时器，不重复设置（合并）
  if (this.state.timer) {
    return;
  }
  this.state.timer = setTimeout(() => this.execute(), delayMs);
}
```

---

## 源码映射表

| 本项目文件 | 行数 | OpenClaw 对应文件 | 原始规模 |
|-----------|------|-------------------|---------|
| `agent.ts` | ~320 | `src/agents/pi-embedded-runner/run.ts` | ~700 行 |
| `session.ts` | ~110 | `src/agents/session-manager.ts` | ~500 行 |
| `memory.ts` | ~170 | `src/memory/manager.ts` | 76KB |
| `context.ts` | ~120 | `src/agents/bootstrap-files.ts` | ~300 行 |
| `skills.ts` | ~230 | `src/agents/skills/` | ~2000 行 |
| `heartbeat.ts` | ~400 | `src/infra/heartbeat-runner.ts`<br>`src/infra/heartbeat-wake.ts` | ~1500 行 |
| `tools/*.ts` | ~210 | `src/tools/` | 50+ 工具 |
| **总计** | **~800** | | **~50,000** |

---

## 快速开始

```bash
# 进入目录
cd examples/openclaw-mini

# 安装依赖
pnpm install

# 设置 API Key
export ANTHROPIC_API_KEY=sk-xxx

# 可选：指定 agentId
export OPENCLAW_MINI_AGENT_ID=main

# 启动交互式对话
pnpm dev chat
```

## 使用示例

```typescript
import { Agent } from "openclaw-mini";

const agent = new Agent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  agentId: "main",
  workspaceDir: process.cwd(),
  enableMemory: true,     // 长期记忆
  enableContext: true,    // 上下文加载
  enableSkills: true,     // 技能系统
  enableHeartbeat: false, // 主动唤醒（默认关闭）
  // 工具策略与沙箱（示意）
  toolPolicy: { deny: ["exec"] },
  sandbox: { enabled: true, allowExec: false, allowWrite: true },
});

// 基本对话（传入 sessionId，会自动补全为 sessionKey）
const result = await agent.run("session-1", "请列出当前目录的文件");

// 使用技能
const review = await agent.run("session-1", "/review src/agent.ts");

// 也可以直接使用 sessionKey
const result2 = await agent.run("agent:main:session-1", "继续刚才的任务");

// 启动主动唤醒
agent.startHeartbeat((tasks, request) => {
  console.log(`[${request.reason}] 检测到 ${tasks.length} 个待办任务`);
});
```

> 记忆使用提示：mini 版改为“工具化记忆”，在系统提示中引导模型先调用 `memory_search` 再 `memory_get` 拉取细节。

## 学习路径建议

1. **先读 `agent.ts`**：理解 Agent Loop 和子系统整合
2. **再读 `heartbeat.ts`**：这是最复杂的部分，理解事件驱动架构
3. **对照 OpenClaw 源码**：验证简化版是否抓住了核心
4. **尝试扩展**：添加新的技能、工具、或改进记忆检索

## 与 OpenClaw 源码对照

本项目位于 `examples/openclaw-mini`，可直接对照父目录的 OpenClaw 源码学习：

```
openclaw/
├── src/
│   ├── infra/heartbeat-runner.ts    ← 对照 examples/openclaw-mini/src/heartbeat.ts
│   ├── infra/heartbeat-wake.ts      ← 对照 examples/openclaw-mini/src/heartbeat.ts
│   ├── memory/manager.ts            ← 对照 examples/openclaw-mini/src/memory.ts
│   ├── agents/bootstrap-files.ts    ← 对照 examples/openclaw-mini/src/context.ts
│   └── agents/skills/               ← 对照 examples/openclaw-mini/src/skills.ts
└── examples/
    └── openclaw-mini/               ← 本项目 (~800 行)
```

## License

MIT
