# C++ 自动化运行架构

## 分层职责

- **Strategy**：`StrategicEngine` 保留长期战略、中文战术表、记忆与持久化，默认每四分钟更新，可与脚本执行并行。
- **Distribution**：读取战略、库存、周围环境、当前脚本进度、已排队工作及长期记忆；一次安排多项完整 C++ 脚本，在当前任务开始后便并行准备后续工作。
- **Action**：`NativeExecutor` 只接受脚本目录中的任务。挖掘、寻路、材料预检、放置、成品复核及脚本循环都在 C++ 完成；一次脚本失败后丢弃依赖它的余下任务，不盲目重试。
- **Tac**：常驻 C++ `--monitor` 进程读取公开 API 观测快照，在不需要模型的情况下检查近身战斗、岩浆、窒息、着火、坠落、低血和死亡。抢占时终止普通脚本、等待公开 `/stop` 确认，先运行攻击脚本，再进行逃生、进食或掩体恢复。
- **Node.js**：只保留公开 HTTP API 转发、C++ 子进程/任务队列生命周期、LLM、持久化/UI 和 Tac 抢占协调。API 映射为固定白名单；方块批量观察由最多八个公开 `/get_block` 请求并发组成，不新增服务端接口。

## C++ 脚本目录

`chop_tree`、`mine_vein` 按背包总量目标循环观察目标、检查空间、寻路、选择工具、挖掘并核实入包；目标不足以安全继续时停止并报告原因。`fishbone_mine` 负责同层主巷、支巷和返回，每轮默认最多挖 96 块，硬上限 192；预算内资源目标未完成时交回 Distribution 再规划，不会悄悄续挖。

`move_to`、`route_navigate` 和 `navigation_recover` 会验证支撑和脚/头净空。普通远行按总路程拆成约九格的移动段，短终段一次到达，并优先选择近似同高的落脚点。当前段直接寻路失败后，只运行有界的局部回退；远距离地下施工先调整高度，再水平搭路或挖路。施工仍受方块触及距离限制，会逐格复查。

`staircase_up` / `staircase_down` 检查当前上方余量、下一落脚列三格净空与脚下支撑。`bridge_to` 和 `pillar` 在材料与空间核实后放置并复查。

`build_base` 用于早期临时基地：以当前位置为中心先清空火柴盒施工体积，发现地板为空气时补齐建筑方块，再按墙体、屋顶、工作台、熔炉、箱子的顺序施工，并把完成空间和基地锚点写入状态；动作可从阶段断点继续。旧 `build_workarea` 仍保留给需要天然岩壁的兼容任务。`workshop` 覆盖白名单配方合成、熔炼、储存与取物；每次合成先由本地配方表检查实际原料，熔炼先检查输入、燃料和输出槽。未知配方会拒绝调用 `/craft`。

`jump_attack` 在 `native/agent/combat.cpp` 使用公开 `/control` 的 jump/hit 参数；跳起后刷新目标和自身位置，按目标身体高度重算角度，并在 hit 同一请求中携带 yaw/pitch，避免使用起跳前的旧视线。近距站位只走已验证地面，不启动追击寻路。`hits[].entity` 只证明攻击包选中了谁，确认掉血单独记录；是否造成伤害或暴击仍由服务端决定。目标离开视野正常结束，墙体及双方位置未变时不重复触发同一隔墙战斗。相关几何与回包写入 `data/native-state.json` 的 combat 和本地运行日志，不加入 Distribution 常规上下文。`survive` 负责水桶/上岸、逃离和必要时封闭掩体恢复；`recover_loot` 会在重生后查看死亡坐标附近公开掉落实体并重装可用装备。锚点、路线、工作区和待处理死亡信息写入 `data/native-state.json`。被 Tac 中断时，采集脚本按背包现状恢复；中断的逐级施工脚本不会从起点盲目重跑。

没有可执行安全工作的计划会保持空闲，不会通过无限采石维持“自动化占比”。UI 中的占比是该运行时的本地累计脚本时间与等待时间，不代表游戏服务器的 CPU 时间。

## 构建和验证

运行 `npm run build-native` 构建 `native/mc-agent-v2.exe`。新默认运行时要求这个文件存在；构建失败时不会退回旧 JavaScript 动作链。真实世界动作尚未在当前工作会话中逐项实战验证，因此 UI 调试调用和公共 API 回执仍应作为运行期证据。

## 参考实现

- [Mineflayer CollectBlock](https://github.com/PrismarineJS/mineflayer-collectblock)：持续目标集合、最近目标、工具选择、寻路和取消。
- [Baritone](https://github.com/cabaletta/baritone)：移动前检查落脚支撑、净空和可行的放置面。
- [Touhou Little Maid](https://github.com/TartaricAcid/TouhouLittleMaid)：按优先级拆分生存、移动、回血等任务。
- [Maid Useful Task](https://github.com/zxy19/maid_useful_task)：树木采集的“移动/破坏—补位—验证”循环。
- [Minecraft Agent API](https://github.com/Zyzzyva0381/mc-agent-api)：本项目使用的公开控制接口及其具体参数。

这些工程仅作为控制流、优先级和安全检查的设计参考；项目仍只通过赛事公开 HTTP API 观察和控制，不读取世界存档，也不使用管理员接口。
