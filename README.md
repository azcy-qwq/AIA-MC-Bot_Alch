# Minecraft AI Agent

当前默认运行时采用长期战略、短期 Distribution、C++ 自动化 Action 和独立 C++ Tac。除了 LLM 请求、公开赛事 API 转发和生命周期/UI协调外，工具参数、世界修改、材料检查、移动和技能循环均在 C++ 核心执行。整体设计与已知边界见[运行架构说明](docs/native-architecture.md)。

```text
Strategy (LLM, 4 min) ──────┐
                            ├─ Distribution ── C++ script queue ── public API
Tac (persistent C++ monitor)┘       │
       cancel -> /stop -> priority script
```

## 自动化脚本

- `chop_tree`：发现并持续砍树，直到背包达到总原木目标。
- `staircase_up` / `staircase_down`：先尝试直达，再验证净空、支撑后挖出斜向阶梯。
- `fishbone_mine` / `mine_vein`：持续挖掘主巷与支脉或收集已暴露矿脉。
- `jump_attack` / `survive`：近身跳砍、脱离岩浆/缺氧/火焰、进食和低血掩体恢复。
- `build_workarea`：预检后开凿 5×5、三格高工作区，验证并保护已完成空间，设置工作台、熔炉和箱子。
- `build_base`：以当前位置为中心建造可扩展的临时火柴盒；先清空 5×5×3 施工体积，地板空气用建筑方块补齐，再封墙、封顶并放置工作台、熔炉和箱子，最后记录基地锚点。
- `bridge_to` / `pillar`：按材料、支撑面和头顶净空搭路或垫高。
- `workshop`：预检材料后合成、熔炼、储存和取物。
- `route_navigate` / `navigation_recover`：记录锚点和路线，分段重验支撑、净空及路径中的空气。
- `recover_loot`：重生后前往记录的死亡位置收集附近掉落并恢复装备。

普通移动按总路程拆成约 9 格一段，短终段一次到达；优先同高落脚点。普通行走不会被拆成许多两三格移动，施工动作因挖放触及距离会短步验证。任务没有总耗时截断；脚本只在资源目标完成、真实危险、无法安全继续、明确 API 错误或无进展时返回。

## 启动

需要 Node.js 24+ 和支持 C++17 的 g++。编译器可通过 `PATH` 提供；Windows 下也会检查 `C:\Users\20416\Documents\mingw64\bin\g++.exe`。

本地 API 源码位于 [`mc-agent-api/`](mc-agent-api/)，当前上游版本为 1.3.12。使用本地 Minecraft 服务器进行调试时，先安装 API 依赖，并从示例创建本地配置。

```powershell
cd mc-agent-api
npm ci
Copy-Item config.example.json config.json
```

在 `config.json` 中填写 Minecraft 服务器地址、角色白名单和本地 API 口令后启动 API。

```powershell
npm start
```

本地 API 口令保存在被 Git 忽略的 `mc-agent-api/config.json` 中。调试面板的账号填写白名单中的角色名，密码填写该配置中的 `auth.password`。游戏服务器上线后即可连接角色。使用比赛 API 时可以直接在调试面板配置赛事 API 地址。

```powershell
npm install
npm run build-native
npm run ui
```

然后打开 `http://127.0.0.1:4173/`，在启动控制中填写公开赛事 API 账号以及可选的 OpenAI 兼容 LLM 配置。API/LLM 凭据只发给本机调试服务，并由 Windows 本机加密保存。没有配置 LLM 时不会假装完成策略决策，也不会靠重复挖石填充空闲时间。

在右上角“启动控制”中的“运行窗口与预算”填写时长、输入/输出Token上限和本轮目标，点击“开启新一轮并启动”。默认4小时、输入8,000,000、输出1,500,000；真正点击前不会创建或启动新窗口。上一轮的会话和完整用量（含未结算预留）先归档到`data/sessions/`，任务记录另存于`docs/run-<开始时间>.md`，记忆与原生脚本进度保留。普通“继续本轮”或“应用更新并重启”沿用原截止时间和用量；到期后这两个按钮禁用。已有Agent运行时需先停止，才允许开启新一轮。若新窗口已经保存但登录失败，修正配置后点“继续本轮”，不要再次开启新一轮。

无 UI 模式可设置 `MC_USERNAME`、`MC_PASSWORD` 及可选 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 环境变量后运行 `npm start`。配置 `DEBUG_UI=0` 可关闭嵌入式面板。

## 调试面板

UI 展示长期 Strategy、Distribution、正在执行的 C++ 脚本、待执行队列、工具/API 请求、周围环境、库存、错误、模型 Token 和脚本运行时间占比。Distribution 在任务开始后便可并行准备后续任务。Tac 在单独的常驻 C++ 进程内运行，不需要为周期性风险检测调用 LLM。

本地人工提示可从 UI 输入。Reflection 与 Strategy、Distribution 使用独立模型层；Reflection Token 按现有统计约定单独显示，不计入主合计。`data/native-state.json` 保存锚点、路线、工作区和待恢复死亡信息；Strategy、Memory、Reflection 及 LLM 对话另存于 `data/`。

## 验证

```powershell
npm run build-native
node --test test/native-core.test.js
```

定向检查直接启动编译后的 C++ 可执行文件并通过模拟公开 API 验证约 9 格移动分段、缺料时拒绝 `/craft`，以及 Distribution 对原始 API 动作的拒绝。当前这些检查没有替代真实世界内的实战确认。

项目只使用比赛公开 API；不读取世界存档，不使用管理员命令。

多 bot 编排入口及隔离边界见[多 bot 运行说明](docs/multi-bot.md)。不同 bot 共享同一套代码和编译核心，但分别连接、保存记忆与状态；同一 skill 可跨 bot 并行，单个 bot 内仍按队列顺序执行。

## 参考

- [Mineflayer CollectBlock](https://github.com/PrismarineJS/mineflayer-collectblock)
- [Baritone](https://github.com/cabaletta/baritone)
- [Touhou Little Maid](https://github.com/TartaricAcid/TouhouLittleMaid)
- [Maid Useful Task](https://github.com/zxy19/maid_useful_task)
- [Minecraft Agent API](https://github.com/Zyzzyva0381/mc-agent-api)

参考项目用于任务优先级、安全检查、路线和采集控制流设计，具体实现仍受本项目赛事 API 的公开能力约束。
