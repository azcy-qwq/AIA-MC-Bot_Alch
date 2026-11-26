# 多 bot 运行

`createMultiBotRuntime` 使用同一份技能和 C++ 核心创建多个相互独立的运行时。每个 bot 的 API 地址、账号、记忆、路线、原生状态、会话预算副本、Token 账本和动作队列都独立保存；共享的是程序代码，不共享运行数据或 skill 队列。

不同 bot 同时提交同一个 skill 时，各自的执行器会立即启动，不经过全局 skill 锁。每个 bot 自己的动作队列仍串行，避免同一游戏角色同时移动、挖掘或交互。批量提交应使用 `Promise.all`，不要先 `await` 第一个长任务再提交第二个。

不同 bot 应使用各自可登录的账号与服务端会话。服务器或 API 不允许同账号多开时，需要为每个 bot 配独立账号；调度层还需避免多个 bot 抢同一份实体目标或重复占用同一区域。

```js
import { createMultiBotRuntime } from "../src/multi-bot.js";

const bots = createMultiBotRuntime({
  bots: [
    { id: "miner-1", name: "矿工一号", url: "https://server-one/api/v1", username: "bot1", password: "..." },
    { id: "miner-2", name: "矿工二号", url: "https://server-two/api/v1", username: "bot2", password: "..." }
  ],
  stateRoot: "data/bots"
});

await bots.startAll();
await Promise.all([
  bots.enqueue("miner-1", { type: "fishbone_mine", params: { laneId: "1" } }),
  bots.enqueue("miner-2", { type: "fishbone_mine", params: { laneId: "1" } })
]);
```

不要让多个运行时共享同一个状态目录；管理器会按 `id` 自动分目录，并分别保存对话、Token 账本、记忆、进度、路线、原生状态和耗时模型。每个 bot 使用自己的 API 客户端与 C++ 子进程，但载入同一份编译好的核心程序。

并发保证只针对本程序的调度层。如果服务端按账号、世界或 IP 限制并发，服务端仍可能排队；要让 bot 独立行动，应给它们配置各自可连接的 API 地址和账号。UI 仍是当前单 bot 调试入口，多 bot 编排由上层进程调用管理器的 `snapshot()` 和 `startBot/stopBot`。
