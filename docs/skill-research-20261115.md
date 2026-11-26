# 2026-11-15 自动化技能源码调研与改进

本轮直接阅读公开工程源码，按接口约束重新实现为 C++；参考 Java/TypeScript 文件不参与编译，也不向游戏安装 MOD。版本信息见 references/source-versions-20261115.json。

| 来源 | 源码中可借鉴的机制 | 本项目改进 |
| --- | --- | --- |
| [TLM MaidMoveToBlockTask](https://github.com/TartaricAcid/TouhouLittleMaid/blob/8a3ac5e9eacf0c6d63adf8832949f3ce81484fe6/src/main/java/com/github/tartaricacid/touhoulittlemaid/entity/ai/brain/task/MaidMoveToBlockTask.java) | 保留 currentWorkPos，以同层优先搜索可达工作点；目标记忆与行走记忆分别保存 | facilityCache 保留最近可用工作站；使用前验证实际方块和可达性；approach 的第一侧失败后尝试其他有支撑、两格净空的位置 |
| [TLM MaidArriveAtBlockTask](https://github.com/TartaricAcid/TouhouLittleMaid/blob/8a3ac5e9eacf0c6d63adf8832949f3ce81484fe6/src/main/java/com/github/tartaricacid/touhoulittlemaid/entity/ai/brain/task/MaidArriveAtBlockTask.java) | 到达与执行分离，目标失效时清理对应目标，而非当作动作已完成 | 工作站位置缓存始终由实际 get_block 复核；已穿戴盔甲按实际 armor 识别，装备之后再次核对栏位 |
| [Maid Useful Tasks: MaidTreeTask](https://github.com/zxy19/maid_useful_task/blob/59d201f20223cc414c091daebed772a805f2eebf/src/main/java/studio/fantasyit/maid_useful_task/task/MaidTreeTask.java) | 树木连通检索、验证记忆、按目标选择工具，砍树与垫高分别作为子行为 | 当前树连通坐标持久化，批量处理后再扫描；达到原木总目标仍收尾当前普通树；可触及高处优先，未处理树冠明确记录为不完整 |
| [CollectBlock](https://github.com/PrismarineJS/mineflayer-collectblock/blob/master/src/CollectBlock.ts) | 把选工具、挖掘和掉落物收集连接起来；拾取与挖掘共享目标队列 | 新增 collect_drops 原生技能，砍树按批次与树末补收；gained 依据真实背包差，不把移动次数当作拾取数量 |
| [Pathfinder goals](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/goals.js) | GoalLookAtBlock 区分目标方块和可交互站位；GoalCompositeAny 可选择等价目标 | 靠近工作站和拾取掉落物时尝试等价站位，优先原高度，失败由本地循环换侧处理 |

## 本轮落实

- `native/agent/trees.cpp`：一次完整砍树任务持有同一棵树的坐标，普通6格白桦实测模拟可以完整砍完；不会每挖一块调用模型。
- `native/agent/pickup.cpp`：`collect_drops {types:["raw_iron"], radius:6}`。types 可省略以收取附近掉落物，radius 限制为1至12格；只移动至经过支撑/两格净空验证的站位，不为了拾取开挖新通路。到达一次站位后处理下一目标；不可达目标跳过并计数，最后用背包增量报告 gained。该技能不保证收取不可达或悬空掉落物。
- `native/agent/navigation.cpp`：`approach` 不再让首个不可达站位结束整个工作任务，恢复性寻路失败由 C++ 继续换侧；普通移动仍以约9格为中距段。
- `native/agent/workshop.cpp`：工作站缓存可复用，指定 target 仍严格指向该站；临时工作台位置写入 native-state，同一次 DAG/整批 workshop 完成后才回收，中途失败保留工作台。`total=true` 的盔甲目标包含已穿戴部分，减少重复合成请求。
- `native/agent/work.cpp`：鱼骨内部由自己的扫矿循环负责沿途采矿，避免每挖一格又嵌套通用扫矿；同一站位在没有新挖掘时复用刚才扫描结果。其他通道每个施工步收尾扫一次，普通 dig 的顺带挖矿仍保留。

## 验证边界

针对性模拟检查包括整棵白桦、装备状态复核、多产物工作台生命周期、失败保留工作台、等价拾取站位与工作站换侧。它们验证控制逻辑，不代替真实服务器的挖掘/拾取/碰撞表现。

尚未实现 TLM 的完整树木天然性验证、重新种树，以及跨多根脚手架自动遍历任意宽度树冠，也没有移植可直接访问世界方块的服务端 BFS。API 无法提供的信息不会从世界存档获取。失败目标仍可能需要 Distribution 修复，不能宣称所有地形已覆盖。

## 01:56 树冠垫高与拆除

进一步参考 Maid Useful Tasks 的 [BlockUpPlaceBehavior](https://github.com/zxy19/maid_useful_task/blob/59d201f20223cc414c091daebed772a805f2eebf/src/main/java/studio/fantasyit/maid_useful_task/behavior/common/BlockUpPlaceBehavior.java)、同目录 BlockUpDestroyBehavior 和 BlockUpContext，按公开 API 重新实现上升采伐与拆柱下降。

脚本保留当前树连通集，够不到的高枝由同柱跳跃垫高逐层接近，沿途清理本树原木/树叶。独立 treePillar 记录 base、dimension、phase、placed 坐标/材料/确认标志，每层落盘；重启或中断后普通工作先恢复下降，Tac 保留优先权。柱顶挖掘 collect=false，不调用掉落物寻路，回地面后才补收。下降仅拆记录中材料匹配的自建块，验证下一层支撑，不破坏天然地基。

模拟已验证12格高树完整采伐、按放置逆序下降、返回原高度，以及最后一次放置响应丢失后的恢复。尚未完成真实高树实测，不能认为所有碰撞/树冠形状已经覆盖。

## 02:57 松散顶板处理

复核已缓存的 Baritone MovementAscend.java：上行移动把源站位的头顶松散块与目标台阶分别判断，不能把“可挖”误当作“挖了不会塌”。本项目依照这个风险区分独立实现公开API可用的有限处理：清理目标上方连续砂/红砂/砂砾之前，先找出可触及的整段柱顶；可安全触及则从上往下清理，顶部不拾取以避免寻路离开施工站位。整柱超出4.5格触及范围、涉及保护区或柱顶液体/未知时，保留支撑。普通开挖也检查正上方液体。仍不会自动处理无限高砂砾层，不读取世界存档，也未直接复制Java逻辑。
