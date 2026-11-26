const BASE_URL = "http://127.0.0.1:18900/api/v1";

/**
 * @typedef {Object} ApiError
 * @property {string} [code] API 返回的业务错误代码。
 * @property {string} [message] 便于阅读的错误信息。
 * @property {Vector3} [pos] 错误发生的位置。
 * @property {string} [interrupted_by] 中断动作的事件或原因。
 * @property {number} [health] 出错或中断时的生命值。
 * @property {EntitySummary} [nearest_hostile] 最近的敌对生物。
 * @property {Object<string, *>} [details] API 提供的附加上下文信息。
 */

/**
 * API 请求错误，保留 HTTP 状态和服务端错误详情。
 * @typedef {Error & {status?: number, code?: string, details?: ApiError}} ApiClientError
 */

/**
 * 三维坐标，顺序为 `[x, y, z]`。
 * @typedef {[number, number, number]} Vector3
 */

/**
 * @template T
 * @typedef {Object} ApiResponse
 * @property {boolean} ok 请求是否在业务层面成功。
 * @property {number} [ms] 服务端处理耗时，单位为毫秒。
 * @property {T} [result] 当前接口成功时返回的结果。
 * @property {ApiError} [error] 当前接口的错误详情。
 */

/**
 * 可由坐标数组或 x/y/z 字段表示的位置。
 * @typedef {Object} CoordinateInput
 * @property {Vector3} [pos] 目标坐标，格式为 `[x, y, z]`。
 * @property {number} [x] X 坐标。
 * @property {number} [y] Y 坐标。
 * @property {number} [z] Z 坐标。
 */

/**
 * 背包或装备栏中的物品堆叠。
 * @typedef {Object} ItemStack
 * @property {string} name 物品标识名，例如 `iron_sword`。
 * @property {number} count 堆叠数量。
 * @property {number} [slot] 背包栏位编号。
 * @property {[number, number]} [durability] 当前耐久与最大耐久。
 * @property {Array<{name: string, level: number}>} [enchantments] 附魔列表。
 * @property {string} [custom_name] 自定义名称。
 * @property {Object<string, *>} [potion] 药水数据。
 * @property {Array<Object<string, *>>} [banner_patterns] 旗帜图案。
 */

/**
 * 实体的简要信息。
 * @typedef {Object} EntitySummary
 * @property {number} id 实体 ID。
 * @property {string} name 实体名称。
 * @property {Vector3} [pos] 实体坐标。
 * @property {number} [dist] 与 Bot 的距离。
 * @property {number} [health] 实体生命值。
 */

/**
 * 当前药水效果。
 * @typedef {Object} EffectInfo
 * @property {string} name 效果名称。
 * @property {number} level 效果等级，从 1 开始。
 * @property {number} duration_s 剩余时间，单位为秒。
 */

/**
 * Bot 当前状态。
 * @typedef {Object} StatusResult
 * @property {string} username Bot 名称。
 * @property {Vector3} pos 当前坐标。
 * @property {number} yaw 水平朝向，单位为弧度。
 * @property {number} [pitch] 垂直朝向，单位为弧度。
 * @property {string} dimension 所在维度。
 * @property {string} gamemode 游戏模式。
 * @property {number} health 当前生命值。
 * @property {number} food 当前饥饿值。
 * @property {number} saturation 当前饱和度。
 * @property {number} xp_level 经验等级。
 * @property {number} xp_progress 当前等级内的经验进度，范围为 0-1。
 * @property {number} oxygen 氧气值。
 * @property {number} armor_points 护甲值，范围为 0-20。
 * @property {ItemStack|null} held 主手物品。
 * @property {ItemStack|null} offhand 副手物品。
 * @property {EffectInfo[]} effects 当前药水效果。
 * @property {boolean} on_fire 是否着火。
 * @property {boolean} is_sleeping 是否正在睡觉。
 * @property {boolean} in_water 身体是否处于水中。
 * @property {boolean} submerged 头部是否处于水下。
 * @property {boolean} in_lava 是否处于岩浆中。
 * @property {EntitySummary|null} in_vehicle 当前载具；未乘坐时为 null。
 * @property {boolean} sneaking 是否潜行。
 * @property {boolean} blocking 是否举盾。
 * @property {{name: string, elapsed_ms: number}|null} using_item 当前正在使用的物品。
 * @property {number} time_of_day 当前世界时间。
 * @property {boolean} is_day 当前是否为白天。
 * @property {boolean} raining 当前是否下雨。
 * @property {boolean} thundering 当前是否雷暴。
 * @property {string} biome 当前生物群系。
 * @property {boolean} on_ground 是否站在地面上。
 * @property {boolean} alive 是否存活。
 * @property {boolean} ready 是否已在比赛服且可以执行动作。
 * @property {string|null} busy 当前执行的动作；空闲时为 null。
 * @property {EntitySummary} [nearest_hostile] 24 格内最近的敌对生物。
 * @property {{pos: Vector3, t: number, cause: string}} [last_death] 最近一次死亡记录。
 */

/**
 * 背包查询结果。
 * @typedef {Object} InventoryResult
 * @property {ItemStack[]} items 背包物品。
 * @property {{head: ItemStack|null, chest: ItemStack|null, legs: ItemStack|null, feet: ItemStack|null}} armor 盔甲栏。
 * @property {ItemStack|null} offhand 副手物品。
 * @property {ItemStack|null} held 主手物品。
 * @property {number} empty_slots 空栏位数量。
 */

/**
 * 方块信息。
 * @typedef {Object} BlockInfo
 * @property {string} name 方块名称。
 * @property {Vector3} pos 方块坐标。
 * @property {Object<string, string|number|boolean>} [properties] 方块状态属性。
 * @property {[number, number]} [growth] 当前生长阶段和最大阶段。
 * @property {boolean} [mature] 作物是否成熟。
 * @property {boolean} [diggable] 是否可挖掘。
 * @property {number} [hardness] 方块硬度。
 * @property {boolean} [harvest_tool_ok] 当前工具是否适合采集。
 * @property {number} [dist] 与 Bot 的距离。
 */

/**
 * 查找方块时的查询条件。
 * @typedef {Object} FindBlocksParams
 * @property {string[]} [types] 方块名称数组；省略时查询附近方块种类摘要。
 * @property {number} [radius=16] 搜索半径，范围为 1-64。
 * @property {number} [limit=20] 最多返回的方块数量。
 * @property {Object<string, string|number|boolean>} [properties] 方块属性筛选条件。
 * @property {boolean} [mature] 是否只返回成熟作物。
 */

/**
 * 指定方块种类后的匹配结果。
 * @typedef {Object} FindBlocksMatchesResult
 * @property {number} total 找到的方块总数。
 * @property {BlockInfo[]} blocks 匹配的方块列表。
 */

/**
 * 未指定方块种类时的附近方块摘要。
 * @typedef {Object} FindBlocksSummaryResult
 * @property {number} radius 本次搜索半径。
 * @property {number} scanned 扫描过的方块数量。
 * @property {Object<string, {count: number, nearest: Vector3, dist: number}>} blocks 按方块名称索引的数量、最近坐标和距离。
 */

/**
 * 查找方块结果：指定类型时返回列表，否则返回摘要。
 * @typedef {FindBlocksMatchesResult|FindBlocksSummaryResult} FindBlocksResult
 */

/**
 * 查找实体的查询条件。
 * @typedef {Object} GetEntitiesParams
 * @property {number} [radius] 搜索半径。
 * @property {Array<'hostile'|'animal'|'player'|'item'|'other'|string>} [types] 实体类别或具体实体名称。
 */

/**
 * 实体查询结果。
 * @typedef {Object} GetEntitiesResult
 * @property {Array<EntitySummary & {type: string, item?: string}>} entities 按距离排序的实体列表，最多 40 个。
 */

/**
 * 事件记录。不同事件类型会带有各自的附加字段。
 * @typedef {Object} AgentEvent
 * @property {number} seq 自增事件序号。
 * @property {number} t 事件时间戳，Unix 毫秒。
 * @property {'chat'|'hurt'|'death'|'spawn'|'pickup'|'effect_start'|'effect_end'|'sleep'|'wake'|'vehicle'|'kicked'|'disconnected'|'death_loop'|'server_confirmed'|string} type 事件类型。
 * @property {string} [text] 聊天内容。
 * @property {number} [health] 受伤后的生命值。
 * @property {number} [damage] 受到的伤害。
 * @property {EntitySummary} [likely_attacker] 可能的攻击者。
 * @property {Vector3} [pos] 事件发生的位置。
 * @property {Vector3} [dropped_items_at] 掉落物位置。
 * @property {string} [item] 物品名称。
 * @property {number} [count] 物品数量。
 * @property {number} [level] 效果等级。
 * @property {number} [duration_s] 效果持续时间。
 * @property {'mount'|'dismount'} [action] 上下载具动作。
 * @property {string} [name] 实体、效果或载具名称。
 * @property {string} [reason] 断开或踢出原因。
 * @property {number} [deaths] 死亡次数。
 * @property {number} [cooldown_until] 冷却结束时间。
 * @property {string} [server] 服务器名称。
 * @property {string} [via] 确认服务器的方式。
 */

/**
 * 事件流查询条件。
 * @typedef {Object} EventsParams
 * @property {number} [since=0] 只返回序号大于该值的事件。
 * @property {number} [limit=50] 每次最多返回数量，范围为 1-500。
 */

/**
 * 事件流查询结果。
 * @typedef {Object} EventsResult
 * @property {number} since 本次查询使用的起始序号。
 * @property {number} last_seq 当前批次游标，可作为下次查询的 since。
 * @property {number} total 符合条件的事件总数。
 * @property {boolean} [has_more] 是否还有尚未返回的事件。
 * @property {AgentEvent[]} events 事件列表。
 */

/**
 * Advancement 查询条件。
 * @typedef {Object} AdvancementsParams
 * @property {'completed'|'in_progress'|'all'|string} [status] 进度状态筛选。
 * @property {boolean} [include_recipes=false] 是否包含配方。
 */

/**
 * 单项 Advancement。
 * @typedef {Object} AdvancementEntry
 * @property {string} id 进度 ID。
 * @property {string} title 显示标题。
 * @property {string} frame 进度边框类型。
 * @property {string} status 当前状态。
 * @property {number|null} [completed_at] 完成时间。
 * @property {Object<string, *>} [progress] 进度详情。
 */

/**
 * Advancement 查询结果。
 * @typedef {Object} AdvancementsResult
 * @property {boolean} ready 进度数据是否已经就绪。
 * @property {number|string} [updated_at] 最近更新时间。
 * @property {number} [packets_received] 已接收的数据包数量。
 * @property {Object<string, *>} [summary] 进度汇总。
 * @property {AdvancementEntry[]} advancements 可见的进度列表。
 */

/**
 * 动作通用的中断条件。
 * @typedef {Object} ActionOptions
 * @property {Array<'hurt'|'death'|string>} [stop_on=['hurt','death']] 遇到这些事件时中断动作。
 */

/**
 * 移动请求参数。
 * @typedef {CoordinateInput & ActionOptions & {entity_id?: number, range?: number}} MoveToParams
 */

/**
 * 挖掘请求参数。
 * @typedef {CoordinateInput & ActionOptions & {collect?: boolean}} DigParams
 */

/**
 * 挖掘结果。
 * @typedef {Object} DigResult
 * @property {string} dug 被挖掘的方块名称。
 * @property {number} dig_ms 挖掘耗时，单位为毫秒。
 * @property {string} [tool] 使用的工具。
 * @property {Object<string, number>} [gained] 获得物品及数量。
 * @property {boolean} [sneaked] 挖掘时是否潜行。
 * @property {string} [warning] 提示信息。
 */

/**
 * 放置方块请求参数。
 * @typedef {Object} PlaceParams
 * @property {string} item 要放置的物品名称。
 * @property {Vector3} [pos] 放置坐标；省略时由服务端选择附近位置。
 */

/**
 * 放置方块结果。
 * @typedef {Object} PlaceResult
 * @property {string} placed 已放置的方块名称。
 * @property {Vector3} pos 放置坐标。
 * @property {boolean} [sneaked] 放置时是否自动潜行。
 */

/**
 * 对方块的交互请求。
 * @typedef {Object} BlockInteractParams
 * @property {Vector3} [pos] 方块坐标。
 * @property {number} [x] 方块 X 坐标。
 * @property {number} [y] 方块 Y 坐标。
 * @property {number} [z] 方块 Z 坐标。
 * @property {string} [item] 交互时使用的物品。
 */

/**
 * 对实体的交互请求。
 * @typedef {Object} EntityInteractParams
 * @property {number} entity_id 目标实体 ID。
 * @property {string} [item] 交互时使用的物品。
 */

/**
 * 方块或实体交互请求参数。
 * @typedef {BlockInteractParams|EntityInteractParams} InteractParams
 */

/**
 * 窗口目标，可指定坐标、实体 ID 或方块名称。
 * @typedef {Object} WindowTarget
 * @property {Vector3} [pos] 方块坐标。
 * @property {number} [entity_id] 实体 ID。
 * @property {string} [block] 方块名称。
 */

/**
 * 使用物品的目标。
 * @typedef {{entity_id: number}|{pos: Vector3}} UseItemTarget
 */

/**
 * 使用物品请求参数。
 * @typedef {Object} UseItemParams
 * @property {string} item 背包中的物品名称。
 * @property {UseItemTarget} [target] 需要瞄准的实体或坐标。
 * @property {number} [ms=1000] 保持使用的时长，最大 10000 毫秒。
 * @property {number} [timeout=30000] 等待物品效果完成的超时时间。
 * @property {'hand'|'off-hand'} [source='hand'] 使用主手或副手中的物品。
 */

/**
 * 使用物品的结果。具体字段取决于物品种类。
 * @typedef {Object} UseItemResult
 * @property {Object<string, number>|string} [used] 使用的物品及数量。
 * @property {number} [food_before] 使用前的饥饿值。
 * @property {number} [food] 使用后的饥饿值。
 * @property {number} [health_before] 使用前的生命值。
 * @property {number} [health] 使用后的生命值。
 * @property {EffectInfo[]} [effects] 使用后获得的效果。
 * @property {number} [blocked_ms] 举盾时长。
 * @property {boolean} [thrown] 是否已投掷。
 * @property {boolean} [teleported] 末影珍珠是否已传送。
 * @property {Vector3} [pos] 使用后的位置。
 * @property {Vector3} [landed_at] 末影之眼落点。
 * @property {Vector3} [eye_vector] 末影之眼方向向量。
 * @property {number} [bearing_deg] 末影之眼方位角。
 * @property {ItemStack|null} [caught] 钓到的物品。
 * @property {number} [wait_ms] 等待咬钩的时间。
 * @property {number} [observed_ms] 望远镜观察时长。
 * @property {EntitySummary} [entity] 使用物品生成的实体。
 * @property {number} [elapsed_ms] 使用持续时间。
 */

/**
 * 攻击请求参数。
 * @typedef {ActionOptions & {entity_id: number, timeout?: number}} AttackParams
 */

/**
 * 攻击结果。
 * @typedef {Object} AttackResult
 * @property {boolean} killed 目标是否被击杀。
 * @property {number} hits 攻击命中次数。
 * @property {number} ms 攻击耗时，单位为毫秒。
 * @property {Object<string, number>} [inventory] 自动拾取的物品及数量。
 */

/**
 * 远程攻击请求参数。
 * @typedef {ActionOptions & CoordinateInput & {entity_id?: number, weapon: 'bow'|'crossbow'|'trident'|string, charge_ms?: number}} ShootParams
 */

/**
 * 远程攻击结果。
 * @typedef {Object} ShootResult
 * @property {boolean} fired 是否成功发射。
 * @property {string} weapon 使用的武器。
 * @property {Vector3} target 瞄准位置。
 * @property {number} dist 与目标的距离。
 * @property {number} [charge_ms] 蓄力时间。
 * @property {{flight_ticks: number, elevation_degrees: number, predicted_miss: number}} [aim] 弹道计算信息。
 * @property {Array<{id: number, name: string, pos: Vector3}>} [projectiles] 发射出的弹射物。
 * @property {Object<string, number>} [used] 消耗的物品及数量。
 */

/**
 * 合成请求参数。
 * @typedef {Object} CraftParams
 * @property {string} item 要合成的物品名称。
 * @property {number} [count=1] 合成数量。
 */

/**
 * 合成结果。
 * @typedef {Object} CraftResult
 * @property {string} crafted 合成的物品名称。
 * @property {number} gained 获得数量。
 * @property {boolean} used_table 是否使用了工作台。
 * @property {Object<string, number>} [inventory] 合成后相关物品库存。
 */

/**
 * 窗口操作类型：放入物品。
 * @typedef {Object} WindowPutOperation
 * @property {'put'} op 操作类型。
 * @property {string} item 要放入的物品名称。
 * @property {number} [count] 放入数量。
 * @property {string} [to] 放入的分区。
 * @property {number|string} [slot] 目标栏位。
 * @property {string} [potion] 药水类型。
 * @property {boolean} [enchanted] 是否要求附魔物品。
 * @property {string} [custom_name] 自定义物品名称。
 */

/**
 * 窗口操作类型：取出物品。
 * @typedef {Object} WindowTakeOperation
 * @property {'take'} op 操作类型。
 * @property {string} [from] 取出物品的分区。
 * @property {string} [item] 指定物品名称。
 * @property {number} [count] 取出数量。
 */

/**
 * 窗口操作类型：选择选项。
 * @typedef {Object} WindowSelectOperation
 * @property {'select'} op 操作类型。
 * @property {string|number} option 要选择的选项。
 * @property {number} [times] 选择次数。
 */

/**
 * 窗口操作类型：输入文本。
 * @typedef {Object} WindowTextOperation
 * @property {'text'} op 操作类型。
 * @property {string} value 要输入的文本。
 */

/**
 * 窗口操作。
 * @typedef {WindowPutOperation|WindowTakeOperation|WindowSelectOperation|WindowTextOperation} WindowOperation
 */

/**
 * 窗口查看或操作请求参数。
 * @typedef {Object} WindowParams
 * @property {WindowTarget} [target] 窗口目标。
 * @property {Vector3} [pos] 扁平格式的目标坐标。
 * @property {number} [x] 扁平格式的目标 X 坐标。
 * @property {number} [y] 扁平格式的目标 Y 坐标。
 * @property {number} [z] 扁平格式的目标 Z 坐标。
 * @property {number} [entity_id] 扁平格式的实体 ID。
 * @property {string} [block] 扁平格式的方块名称。
 */

/**
 * 窗口查看结果。
 * @typedef {Object} WindowViewResult
 * @property {string} window 窗口类型。
 * @property {string} target 实际打开的目标。
 * @property {Object<string, ItemStack[]>} sections 各窗口分区及其物品。
 * @property {Object<string, *>} [info] 窗口专属信息，例如熔炉进度。
 */

/**
 * 装备请求参数。
 * @typedef {Object} EquipParams
 * @property {string} item 要装备的物品名称。
 * @property {'hand'|'off-hand'|'head'|'torso'|'legs'|'feet'} slot 装备栏位。
 */

/**
 * 姿态设置参数。未提供的字段会设为 false。
 * @typedef {Object} PostureParams
 * @property {boolean} [sneak=false] 是否潜行。
 * @property {boolean} [shield=false] 是否举盾。
 */

/**
 * 姿态设置结果。
 * @typedef {Object} PostureResult
 * @property {boolean} sneaking 当前是否潜行。
 * @property {boolean} blocking 当前是否举盾。
 * @property {ItemStack|null} offhand 当前副手物品。
 */

/**
 * 丢弃物品请求参数。
 * @typedef {Object} DropParams
 * @property {string} item 要丢弃的物品名称。
 * @property {number} count 丢弃数量。
 */

/**
 * 聊天请求参数。
 * @typedef {Object} ChatParams
 * @property {string} message 要发送的文本，最多 100 个字符且不能以命令前缀 `/` 开头。
 */

/**
 * @typedef {Object} RequestOptions
 * @property {string} [method="GET"] HTTP 请求方法。
 * @property {Object<string, string|number|boolean|string[]>} [query] URL 查询参数。
 * @property {*} [body] JSON 请求体。
 * @property {Record<string, string>} [headers] 额外的 HTTP 请求头。
 * @property {boolean} [auth=true] 设为 false 时不发送 Bearer Token。
 */

/**
 * @typedef {Object} AgentOptions
 * @property {string} [baseUrl] API 基础地址。
 * @property {string|null} [token] 已有的 Bearer Token。
 */

/**
 * 登录响应。登录接口的 Token 位于顶层，而非 result 中。
 * @typedef {Object} LoginResponse
 * @property {boolean} ok 请求是否成功。
 * @property {string} token Bearer Token。
 * @property {string} expires_at Token 过期时间。
 * @property {string} bot_username 游戏中的 Bot 名称。
 * @property {number} [ms] 服务端处理耗时。
 */

/**
 * 登出响应。该接口示例为顶层 `{ok: true}`。
 * @typedef {{ok: boolean, ms?: number}} LogoutResponse
 */

/**
 * 连接接口结果。
 * @typedef {Object} ConnectionResult
 * @property {boolean} [ok] 连接操作是否成功。
 * @property {boolean} [already_connected] 调用前是否已经连接。
 * @property {boolean} [resent_server_switch] 是否重新发送了切服请求。
 * @property {boolean} [ready] Bot 是否已准备好执行动作。
 */

/**
 * 断开连接接口结果。
 * @typedef {{ok: boolean}} DisconnectResult
 */

/**
 * 移动结果。
 * @typedef {Object} MoveToResult
 * @property {Vector3} pos 到达位置。
 * @property {boolean} [drove] 是否通过驾驶载具移动。
 * @property {EntitySummary} [vehicle] 当前驾驶的载具。
 * @property {number} [dist] 与目标的剩余距离。
 * @property {{from: string, to: string}} [dimension_changed] 移动期间发生的维度变化。
 * @property {number} [ms] 动作耗时。
 */

/**
 * 通用动作成功结果。
 * @typedef {{stopped?: boolean, ok?: boolean}} SimpleActionResult
 */

/**
 * 交互结果。
 * @typedef {Object} InteractResult
 * @property {string} [block] 交互的方块名称。
 * @property {Object<string, *>} [before] 方块交互前的状态。
 * @property {Object<string, *>} [after] 方块交互后的状态。
 * @property {Object<string, *>} [above] 方块上方位置的变化。
 * @property {boolean} [changed] 方块状态是否改变。
 * @property {EntitySummary} [entity] 交互的实体。
 * @property {EntitySummary|null} [in_vehicle] 当前载具。
 * @property {boolean} [vehicle_changed] 本次交互是否改变载具状态。
 * @property {Object<string, number>} [used] 消耗的物品及数量。
 * @property {Object<string, number>} [gained] 获得的物品及数量。
 * @property {boolean} [slept] 是否已入睡。
 * @property {boolean} [woke] 是否已起床。
 */

/**
 * 窗口操作后的状态结果。
 * @typedef {Object} WindowActResult
 * @property {string} window 窗口类型。
 * @property {string} target 实际打开的目标。
 * @property {Object<string, ItemStack[]>} [sections] 操作后的各窗口分区物品。
 * @property {Object<string, *>} [info] 窗口专属信息，例如熔炉进度。
 */

/**
 * 装备结果。
 * @typedef {{held?: ItemStack|null, equipped?: ItemStack|null}} EquipResult
 */

/**
 * 下车结果。
 * @typedef {Object} DismountResult
 * @property {boolean} dismounted 是否成功下车。
 * @property {EntitySummary} [vehicle] 离开的载具。
 * @property {Vector3} [pos] 下车后的坐标。
 */

/**
 * 丢弃物品结果。
 * @typedef {{inventory: Object<string, number>}} DropResult
 */

/**
 * 聊天发送结果。
 * @typedef {{sent: boolean}} ChatResult
 */

/**
 * 中断动作结果。
 * @typedef {{stopped: boolean}} StopResult
 */

/**
 * Minecraft Agent API v1.3 客户端。
 *
 * 每个方法都会返回完整的 API 响应。服务端可能以 HTTP 200 返回业务失败，
 * 此类失败会由 {@link Agent#request} 转换为 Error，调用方可以用统一方式
 * 处理网络错误和 API 错误。
 */
class Agent {
    /**
     * 创建 API 客户端。
     *
     * @param {string} username 皮肤站用户名。
     * @param {string} password 皮肤站密码。
     * @param {AgentOptions} [options] 连接选项。
     */
    constructor(username, password, { baseUrl = BASE_URL, token = null } = {}) {
        this.username = username;
        this.password = password;
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.token = token;
        this.loginPromise = null;
        this.authRetryAt = 0;
        this.authRetryError = null;
    }

    /**
     * 向 API 发送请求。
     *
     * @template [T=any]
     * @param {string} path API 路径，例如 `/status`。
     * @param {RequestOptions} [options] 请求选项。
 * @returns {Promise<T>} 完整的 API 响应；T 为响应类型，省略时按 any 处理。
     * @throws {Error} HTTP 响应或业务响应出错时抛出。
     */
    async request(path, options = {}) {
        if (this.token && this.authRetryAt > Date.now() && path !== "/auth/login" && options.auth !== false) {
            throw this.authRetryError || Object.assign(new Error("API 登录会话暂不可用"), { code: "invalid_token" });
        }
        const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value === undefined || value === null) continue;
            if (Array.isArray(value)) {
                for (const item of value) url.searchParams.append(key, String(item));
            } else {
                url.searchParams.set(key, String(value));
            }
        }

        /** @type {Record<string, string>} */
        const headers = {
            Accept: "application/json",
            ...options.headers
        };
        if (options.body !== undefined && !headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/json";
        }
        if (options.auth !== false && this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? 90000;
        const timeout = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
        const abort = () => controller.abort(options.signal?.reason);
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener("abort", abort, { once: true });
        let response;
        let text;
        try {
            response = await fetch(url, {
                method: options.method || "GET",
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal
            });
            text = await response.text();
        } catch (cause) {
            const error = /** @type {ApiClientError} */ (new Error(cause.name === "AbortError" ? `API request timed out after ${timeoutMs}ms` : cause.message));
            error.code = options.signal?.aborted ? "cancelled" : cause.name === "AbortError" ? "request_timeout" : "network_error";
            error.cause = cause;
            throw error;
        } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener("abort", abort);
        }
        let data = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch {
                data = { message: text };
            }
        }

        if (!response.ok || data?.ok === false) {
            const details = data?.error || data || {};
            const error = /** @type {ApiClientError} */ (new Error(details.message || `HTTP ${response.status}`));
            error.status = response.status;
            error.code = details.code;
            error.details = details;
            if (response.status === 401 && details.code === "invalid_token" && path !== "/auth/login" && options.auth !== false && !options._authRetry && this.username && this.password) {
                try {
                    await this.login();
                    this.authRetryAt = 0;
                    this.authRetryError = null;
                    return this.request(path, { ...options, _authRetry: true });
                } catch (cause) {
                    const authError = Object.assign(new Error(`API 登录会话失效，自动重新认证失败：${cause.message}`), { code: "invalid_token", cause });
                    this.authRetryError = authError;
                    this.authRetryAt = Date.now() + 30000;
                    throw authError;
                }
            }
            throw error;
        }

        return data;
    }

    /**
     * 登录并保存返回的 Bearer Token。
     *
     * @returns {Promise<LoginResponse>} 包含 Token、过期时间和 Bot 名称的登录响应。
     */
    async login() {
        if (this.loginPromise) return this.loginPromise;
        this.loginPromise = (async () => {
            const data = /** @type {LoginResponse} */ (await this.request("/auth/login", {
                method: "POST",
                body: { username: this.username, password: this.password },
                auth: false
            }));
            this.token = data.token;
            return data;
        })();
        try { return await this.loginPromise; }
        finally { this.loginPromise = null; }
    }

    /**
     * 登出并清除已保存的 Token。
     *
     * @returns {Promise<LogoutResponse>} 登出响应，指南中该接口不包含 result。
     */
    async logout() {
        const data = /** @type {LogoutResponse} */ (await this.request("/auth/logout", { method: "POST" }));
        this.token = null;
        return data;
    }

    /**
     * 将 Bot 连接到比赛服务器。
     *
     * @returns {Promise<ApiResponse<ConnectionResult>>} 连接状态及是否已就绪。
     */
    connect() { return this.request("/connect", { method: "POST" }); }

    /**
     * 断开 Bot 与服务器的连接。
     *
     * @returns {Promise<ApiResponse<DisconnectResult>>} 断开结果。
     */
    disconnect() { return this.request("/disconnect", { method: "POST" }); }

    /**
     * 获取 Bot 的连接、位置、生命值和世界状态。
     *
     * @returns {Promise<ApiResponse<StatusResult>>} 状态字段，例如 `result.ready`、`result.health` 和 `result.pos`。
     */
    status() { return this.request("/status"); }

    /**
     * 获取 Bot 的背包、盔甲、副手和手持物品。
     *
     * @returns {Promise<ApiResponse<InventoryResult>>} 背包、盔甲、副手和主手物品。
     */
    inventory() { return this.request("/inventory"); }

    /**
     * 查找 Bot 附近暴露在外的方块。
     *
     * @param {FindBlocksParams} [params={}] 类型、半径、数量上限、属性和成熟度筛选。
     * @returns {Promise<ApiResponse<FindBlocksResult>>} 方块列表或附近方块种类摘要。
     */
    findBlocks(params = {}) { return this.request("/find_blocks", { method: "POST", body: params }); }

    /**
     * 查询指定坐标处的单个方块。
     *
     * @param {CoordinateInput} params 以 `pos` 或 `x`、`y`、`z` 提供方块坐标。
     * @returns {Promise<ApiResponse<BlockInfo>>} 名称、坐标、属性、生长状态和可采集状态。
     */
    getBlock(params) { return this.request("/get_block", { method: "POST", body: params }); }

    /**
     * 查找 Bot 附近的实体。
     *
     * @param {GetEntitiesParams} [params={}] 搜索半径和实体类别或名称。
     * @returns {Promise<ApiResponse<GetEntitiesResult>>} 按距离排序的实体列表。
     */
    getEntities(params = {}) { return this.request("/get_entities", { method: "POST", body: params }); }

    /**
     * 读取事件流。
     *
     * @param {EventsParams} [params={}] `since` 游标和 `limit` 返回数量。
     * @param {'GET'|'POST'} [method="GET"] 使用 `GET` 传递查询参数，或使用 `POST` 传递 JSON 请求体。
     * @returns {Promise<ApiResponse<EventsResult>>} 事件列表、总数和下一次轮询游标。
     * @throws {Error} method 不是 `GET` 或 `POST` 时抛出。
     */
    events(params = {}, method = "GET") {
        const verb = method.toUpperCase();
        if (verb === "GET") return this.request("/events", { query: params });
        if (verb === "POST") return this.request("/events", { method: verb, body: params });
        throw new Error("events method must be GET or POST");
    }

    /**
     * 查询服务器已下发的进度。
     *
     * @param {AdvancementsParams} [params={}] 进度状态和是否包含配方。
     * @returns {Promise<ApiResponse<AdvancementsResult>>} 可见进度列表和汇总。
     */
    advancements(params = {}) { return this.request("/advancements", { method: "POST", body: params }); }

    /**
     * 移动到指定坐标或实体处；骑乘时会驾驶当前载具。
     *
     * @param {MoveToParams} params 坐标或实体目标、到达范围及中断条件。
     * @returns {Promise<ApiResponse<MoveToResult>>} 到达位置、剩余距离及载具/维度变化信息。
     */
    moveTo(params) { return this.request("/move_to", { method: "POST", body: params }); }

    /**
     * 挖掘方块，并可选择收集掉落物。
     *
     * @param {DigParams} params 方块坐标、是否收集掉落物及中断条件。
     * @returns {Promise<ApiResponse<DigResult>>} 挖掘方块、耗时、使用工具和获得物品。
     */
    dig(params) { return this.request("/dig", { method: "POST", body: params }); }

    /**
     * 将物品放置为方块。
     *
     * @param {PlaceParams} params 要放置的物品和可选坐标。
     * @returns {Promise<ApiResponse<PlaceResult>>} 放置的方块、坐标和潜行状态。
     */
    place(params) { return this.request("/place", { method: "POST", body: params }); }

    /**
     * 与方块或实体交互。
     *
     * @param {InteractParams} params 方块坐标或实体 ID，以及可选的交互物品。
     * @returns {Promise<ApiResponse<InteractResult>>} 方块状态变化、物品消耗或实体交互结果。
     */
    interact(params) { return this.request("/interact", { method: "POST", body: params }); }

    /**
     * 不指定方块目标，直接使用物品。
     *
     * @param {UseItemParams} params 物品名称、可选瞄准目标、持续时间、超时和使用手位。
     * @returns {Promise<ApiResponse<UseItemResult>>} 随物品类型变化的使用结果。
     */
    useItem(params) { return this.request("/use_item", { method: "POST", body: params }); }

    /**
     * 跟随并攻击实体，直到目标死亡或操作超时。
     *
     * @param {AttackParams} params 目标实体 ID、超时时间和中断条件。
     * @returns {Promise<ApiResponse<AttackResult>>} 击杀状态、命中次数、耗时和拾取物品。
     */
    attack(params) { return this.request("/attack", { method: "POST", body: params }); }

    /** 原生按键及单次左键；hit 是 /control 的参数。 */
    control(params) { return this.request("/control", { method: "POST", body: params }); }

    /** 朝向实体、坐标或指定 yaw/pitch（弧度）。 */
    look(params) { return this.request("/look", { method: "POST", body: params }); }

    /**
     * 使用弓、弩或三叉戟攻击实体或坐标。
     *
     * @param {ShootParams} params 实体或坐标目标、武器和可选蓄力时间。
     * @returns {Promise<ApiResponse<ShootResult>>} 发射状态、弹道计算、弹射物和消耗品。
     */
    shoot(params) { return this.request("/shoot", { method: "POST", body: params }); }

    /**
     * 合成物品。
     *
     * @param {CraftParams} params 物品名称和合成数量。
     * @returns {Promise<ApiResponse<CraftResult>>} 合成物品、获得数量和工作台使用情况。
     */
    craft(params) { return this.request("/craft", { method: "POST", body: params }); }

    /**
     * 查看容器或实体界面，然后立即关闭。
     *
     * @param {WindowParams} params 界面目标，可放在 `target` 中，也可使用扁平格式传入。
     * @returns {Promise<ApiResponse<WindowViewResult>>} 窗口类型、分区物品和界面专属信息。
     */
    windowView(params) { return this.request("/window/view", { method: "POST", body: params }); }

    /**
     * 打开界面、执行操作列表，然后关闭界面。
     *
     * @param {WindowParams & {ops: WindowOperation[]}} params 界面目标和操作列表。
     * @returns {Promise<ApiResponse<WindowActResult>>} 操作后的窗口结果；操作类型由 `ops` 的 `op` 字段补全。
     */
    windowAct(params) { return this.request("/window/act", { method: "POST", body: params }); }

    /**
     * 将物品装备到主手、副手或盔甲栏位。
     *
     * @param {EquipParams} params 物品名称和装备栏位。
     * @returns {Promise<ApiResponse<EquipResult>>} 主手的 `held` 或副手/盔甲的 `equipped` 物品。
     */
    equip(params) { return this.request("/equip", { method: "POST", body: params }); }

    /**
     * 完整设置潜行和举盾姿态。
     *
     * @param {PostureParams} [params={}] `sneak` 和 `shield` 开关；未提供的字段会重置为 false。
     * @returns {Promise<ApiResponse<PostureResult>>} 潜行、举盾和副手状态。
     */
    posture(params = {}) { return this.request("/posture", { method: "POST", body: params }); }

    /**
     * 离开当前载具。
     *
     * @returns {Promise<ApiResponse<DismountResult>>} 下车状态、载具信息和当前位置。
     */
    dismount() { return this.request("/dismount", { method: "POST" }); }

    /**
     * 丢弃背包中的物品。
     *
     * @param {DropParams} params 物品名称和丢弃数量。
     * @returns {Promise<ApiResponse<DropResult>>} 丢弃后的背包数量信息。
     */
    drop(params) { return this.request("/drop", { method: "POST", body: params }); }

    /**
     * 发送聊天消息。
     *
     * @param {string|ChatParams} message 消息文本，或 `{message: string}` 对象。
     * @returns {Promise<ApiResponse<ChatResult>>} 是否发送成功。
     */
    chat(message) {
        const body = typeof message === "string" ? { message } : message;
        return this.request("/chat", { method: "POST", body });
    }

    /**
     * 停止当前移动或动作，并释放按键。
     *
     * @returns {Promise<ApiResponse<StopResult>>} 是否已停止当前动作。
     */
    stop() { return this.request("/stop", { method: "POST" }); }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { Agent, BASE_URL };
} else {
    /** @type {typeof globalThis & {Agent?: typeof Agent}} */
    const browserGlobal = globalThis;
    browserGlobal.Agent = Agent;
}

// Keep the client usable from both the original browser/CommonJS examples and
// the ESM runtime used by the layered agent.
export { Agent, BASE_URL };
