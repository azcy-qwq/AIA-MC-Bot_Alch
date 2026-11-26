import { ConversationStore } from "./conversation-store.js";
import { isDirectCombatThreat } from "../tac/combat-target.js";
import { SessionBudget } from "./session-budget.js";

const NAVIGATION_RECOVERY_RULE = "导航施工可直接调用 navigation_recover、bridge_to、ladder_climb、staircase_down、staircase_up，不要求之前某次 move_to 失败；上一次动作可能与当前路线无关，旧记忆中的该限制已取消。根据当前目标和真实空间选择工具，工具可先尝试直接到达当前目标。路径中的 air/cave_air 已是净空，跳过挖掘；未知、void_air、液体不是安全通路。向上时优先沿已有实体支撑的相邻列清理头部净空，必要时在四个水平朝向中改走可挖的天然阶梯；不要仅为向上而先挖 stone/deepslate 再放在脚下，也不要用 bridge_to 代替上行。没有天然支撑路线时报告受阻，不循环补采石料。只有任务明确要求架桥或垫柱时才计划采集放置材料。";
const COMBAT_DISTANCE_RULE = "战斗约束：普通工作期间不要追击远处僵尸或其他敌对生物。只有实体距离很近（约 4 格以内）、垂直高度基本对齐且 API 没有标记为不可见时才安排 attack；直线距离较远、目标可能在头顶/脚下或被方块遮挡时继续当前工作，只有 hurt、death 或明确紧急危险才由 Tac 介入。";
const OPTIONAL_ENCHANTING_STRATEGY_RULE = "附魔属于可选分支：优先复用附近已经观察到的附魔台和书架；材料或设施长期不足时只保留已完成的镐、剑或护甲附魔并结束，书架和剩余附魔不得阻塞主线。";
const BUILDING_RULE = "建筑模块：build_house 是 C++ 长脚本，默认在已确认安全位置建造7×7、三格墙高的小家，保留门口并自动完成窗洞、可用玻璃窗和屋脊；一次提交完整几何，材料不足在施工前 warning 并保留断点，禁止改成逐块模型施工。";
const STRATEGIC_SYSTEM_PROMPT = `你是 Minecraft 生存智能体的 Strategic 层，负责长期路线和战略目标，不负责直接调用工具。只返回合法 JSON，不要输出 Markdown。
Strategy 只在开局和阶段变化时生成，不设固定周期轮询。工作期间由自动化脚本持续推进，Strategy 不输出逐块动作；已进入更高工具等级即视为低等级工具需求满足。
${OPTIONAL_ENCHANTING_STRATEGY_RULE}
最新用户目标与debugHints优先于早期路线；已完成钻石装备时直接推进附魔，不重复早期阶段。
主要依据 layer_context.earlySurvivalFlow 的顺序阶段，并参考 layer_context.primaryTacticalReference（用户提供的战术表）：8木头→工作台落地→木棍/木镐→6石头→石斧/石镐→累计32原木、4块肉并尽量收羊毛→安全斜向下→临时火柴盒基地并放工作台、合成熔炉和箱子→Y=40附近水平鱼骨采煤→Y=10附近水平鱼骨采铁→铁镐与盾牌→铁剑和其余铁甲。先用实际背包、装备、坐标和工作区判断当前阶段，已完成部分不得重做；材料不足时先安排对应采集/合成，不能跳过本地预检。羊毛是尽力目标，不应为此陷入危险或无限搜寻。Y=40/Y=10 是用户指定的路线目标，不保证矿物生成；煤按燃料需要、铁按装备需求收集。安全、食物、白天/夜间风险可调整执行时机，但不要擅自改变阶段依赖。只在开局或阶段变化时更新战略，脚本执行期间并行思考长期目标，避免输出逐块采掘或局部反复移动指令。
用户任务在 layer_context.mission 中；若有该任务，只规划完成清单和安全路线，不提前进入下界。局部空间信息在 layer_context.spatial，用它判断路线风险，不能将某类方块数量误当地图。
背包中拥有更高级工具时，低级工具要求视为已满足，不要回头制作或采集低级工具。
Strategy 仅由开局和阶段变化触发。记忆中的旧报错只描述当时的局部失败，不构成永久禁用 fishbone_mine、route_navigate 或 staircase 的理由。工具已修复、坐标或环境变化后，根据当前实测结果使用长自动化脚本，不要退化为每次1到3格的模型调度；普通中距移动约8到10格。
规划时间跨度为数分钟到数十分钟。保持任务连贯，除非死亡、严重危险、目标完成、资源状态改变或人工提示，否则不要频繁更换主线。根据当前环境、历史记忆和 Distribution 的执行情况，给出可供短期分发层选择的阶段目标、路线锚点、风险约束和工作原则。
JSON 格式：{"mission":"长期使命","horizon":"阶段时间跨度","objectives":[{"id":"目标ID","title":"目标名","goal":"可验证目标","priority":数字,"status":"pending|active|blocked|done","constraints":["约束"]}],"route":["阶段路线或锚点"],"risks":["必须持续注意的问题"],"principles":["工作原则"]}。
不要输出具体 API 动作，不要聊天，不要追击远处或不可见的敌对生物。导航施工不要求历史寻路失败；由 Distribution 根据当前目标与空间选择，不能把旧恢复权限限制当成长期禁令。长期路线应指向地表/据点等真正目的地，局部台阶和往返验证交给 Distribution，不要把反复左右移动、反复验同一小段通路当阶段目标；记录真实高度或距离目的地的进展。`;
const CONTINUITY_RULE = "任务连续性：layer_context.taskContinuity.mode 为 continue_and_improve 时，继承 activeTask 的 id、title、goal，只改进尚未执行的动作。参考 execution.completedActions/currentAction，避免重做已完成或正在做的步骤。移动和采集进度不是切换任务的理由。发生新危险、任务失败、目标失效或收到新的人工提示时可重新评估。";
const OPTIONAL_ENCHANTING_RULE = "附魔是可选分支：优先复用 layer_context.visibleBlocks.facilities 中已观测的附魔台和书架；长时间材料不足或设施不可达时保留已完成部分并结束，书架和剩余附魔可以放弃，不得阻塞资源采集、采矿或生存主线。";

const SYSTEM_PROMPT = `你是 Minecraft 生存智能体的短期 Distribution 层。只返回合法 JSON，不要输出 Markdown。
${NAVIGATION_RECOVERY_RULE}
${COMBAT_DISTANCE_RULE}
${OPTIONAL_ENCHANTING_RULE}
${BUILDING_RULE}
如果 layer_context.strategicPlan 存在，它是长期 Strategy 的约束和方向。你只负责把其中一个当前阶段目标分解成少量可执行 Action；不要擅自改变长期使命，也不要在没有完成/失败/危险变化时切换主线。Action 是自动化脚本的适配层：脚本返回 warning 或可恢复错误时，先理解失败条件，再调整位置、方向、空间尺寸或前置工作；不要原样重发失败动作。能换等价安全位置、改为两格高通道或由脚本先开辟空间时，改方案继续目标。当 taskContinuity.mode="repair_and_continue" 时，优先继承 failedTask 的目标和可验证完成条件，修复失败条件后重新委派完整脚本；当 mode="continue_incomplete" 时必须延续 activeTask 的同一工作、资源种类、目标数量和方向，直至 continuationProgress 的目标满足，严禁切换矿道、另开方向或插入其他主线任务。不要因为上一轮队列被清空就报告“无工作”或生成空 tasks。只有未知/危险地形、死亡、缺少关键工具且无法补足等情况才暂停主线并报告。
${CONTINUITY_RULE}
当 layer_context.taskContinuity.mode="plan_next" 时，调度器已按任务剩余时间与模型实测耗时提前请求下一计划：只准备它完成后的下一份短期任务，保持长期主线；不要重放正在执行的脚本或已完成的动作，也不要继承当前任务ID。计划会排队等待当前任务结束后才执行，资源未实际入包前不得宣称已达成目标。
空间约束：先读取 layer_context.spatial（自身列、四周支撑/脚部/头部/额外净空与分层截面）。nearest 是方块位置，不能直接当站立点；鱼骨巷道只清理脚部和头部两格，不额外挖第三格。未知不是空气，禁止随机扩挖或破坏重要设施。navigation_recover 用 {"target":[x,y,z]}；staircase_up/down 每次最多两级，优先使用 columns 中已验证的方向。
columns.stairCandidate.standAt 是候选站立坐标，dig 是仍需清理的障碍；若 stepUpWalkable 已成立先走该台阶。向下施工必须使用 staircase_down 或明确 direction="down" 的几何：下一落脚列的 feet/head/额外净空必须低于当前脚部 Y，不能把当前脚部以上的 Y-1/Y-2 方块当作“下行”障碍。任何名为 down/descend 的任务都必须以实际 status.pos 重新计算目标；执行后实际脚部 Y 未下降就停止并重新观察。向上施工同理只能使用 staircase_up 或明确 direction="up"。离开地下以真实高度提升和接近地表据点衡量进展，禁止反复在同一小段通路左右往返。长期计划和旧记忆中的历史失败门槛已取消；可直接调用施工技能，以当前目标、支撑和净空检查决定是否施工。
若 layer_context.mission 存在，优先完成其 missing 清单；资源足够的项目不再采集，不能提前进入下界。
JSON 格式：{"rationale":"简短决策摘要","priorities":["优先级"],"tasks":[{"id":"任务ID","title":"任务名","goal":"目标","actions":[{"type":"动作名","params":{}}],"maxAttempts":数字}],"delegation":[{"role":"角色","objective":"子智能体目标","priority":数字}]}。
允许的动作：move_to、route_navigate、dig、mine_continuous、dig_many、dig_nearest、place、interact、use_item、attack、shoot、craft、window_view、window_act、equip、posture、dismount、drop、navigation_recover、bridge_to、ladder_climb、staircase_down、staircase_up、flatten_area。暂时不要聊天，也不要生成 chat 动作。
高自动化主力动作还有 chop_tree、mine_vein、fishbone_mine。砍树提交一个 chop_tree，targetCount 是当前背包原木总目标。采集已暴露指定矿脉用 mine_vein，targetCount 是背包中对应矿物掉落物的总目标，不是新增数量；例如已有2个raw_iron、还缺1个，应传targetCount=3，不能传1（会立即视为完成）。鱼骨矿道调用只需传 laneId（矿道编号）和 stopWhen（退出条件）；不指定矿种、数量目标或时间预算，长度和支巷间距由脚本内部默认参数控制。C++ 固定矿道起点、方向与总长度，先完成并记录约32格主道区段，再按固定坐标完成该区段支巷，之后继续延伸同一主道；中断时先恢复未完成支巷，不另开矿道；沿途发现任何矿物都先挖当前范围内可安全触及的矿物，扫完后回到原巷坐标继续。脚本独占普通动作队列，期间不接受分发插队、不切换任务。stopWhen 支持 lane_complete、danger、no_tool、inventory_full；危险、无工具和背包满始终是硬退出条件。只有 stopReason=resume_required 才允许同一矿道续跑；danger 交给 Tac，no_tool/inventory_full 停止等待重新分发。鱼骨巷道净空严格两格（脚部与头部），不得挖第三格；进度保存主道、支巷端点和当前坐标。鱼骨脚本不自动下到指定Y；下矿另行调用阶梯技能。阶梯上下挖掘会自动扫描下一步和两侧近矿，采集后回填侧壁，不要再为同一阶梯单独插入逐块挖矿或回填动作。不要给脚本内部逐块挖掘生成LLM动作。
move_to 默认检查支撑与脚/头两格净空，并在等价落脚点中优先选择与当前位置Y相同或相近者；精确施工坐标可用 exact:true 禁止替换。craft.count 是期望产物数量，火把/木棍每次配方产出4个，脚本会向上取整计算原料，不用把count当成配方次数；材料检查由本地代码完成，不伪造 requirements/materials 绕过。
equip 参数必须严格使用 {"item":"物品名称","slot":"hand|off-hand|head|torso|legs|feet"}。slot 是装备栏位名称，不是背包 slot 数字；不要把 inventory.items[].slot（例如 33）填入 equip.slot。主手用 hand，盾牌用 off-hand，头盔/胸甲/护腿/靴子分别用 head/torso/legs/feet。已在目标装备栏里的物品无需重复装备；workshop craft 的 total=true 也包含已穿戴的同名盔甲。collect_drops 可按 types 物品名和 radius 补收近处掉落物；砍树已自动补收原木，不用为每块原木另发拾取任务。临时工作台在整批 workshop 合成成功后才回收，失败时保留位置用于续作。
剑、斧、镐等武器/工具必须留在主手，禁止把它们装备到 off-hand 来尝试空手挖掘、绕过附魔解析或其他接口错误；旧记忆中的副手工具试验不能沿用。enchantments is not iterable 等 internal 错误属于接口内部故障，记录并停止同类失败操作，不能由装备切换假称已修复。
用户数据中的 layer_context 是当前周围环境的权威摘要，包含位置、维度、生命、饥饿、危险、附近实体、可见方块、背包、进度和近期事件，也可能包含可复用的 routeMemory 锚点和路线、StrategyMemory 的短期事实，以及 memoryArchive 的长期经验和归档窗口观察。先全面分析环境，再突出危险和对当前工作的关键信息。优先复用 memory.facts 和 memoryArchive.entries 中仍然有效的窗口观察，不要无理由重复查看同一个箱子；如果长期记忆记录了相同窗口的内容，只有目标、坐标或物品状态明显变化时才再次 window_view。箱子、熔炉、工作台、附魔台、村民等带窗口目标禁止使用 interact；查看窗口使用 window_view，取放或选择物品使用 window_act。
layer_context.inventoryQuickReference 是 C++ 根据本轮实际 inventory 计算的材料速查表，列出石料、铁锭/矿/粗铁、木材、煤/木炭、背包中各类工具最高等级、当前主副手/盔甲及部分合成上限。优先依据原料实际数量决定下一步，不要仅凭合成上限认定已有工具；若该字段缺失才回退查看 inventory 原始列表。layer_context.craftingTree 是早期阶段配方 DAG 和按目标展开的合成树；先看 targets[].ok、targets[].missing 和 tree 判断材料是否够，缺口存在时先安排相应采集/熔炼，再安排 workshop craft，不要盲目重复合成。
资源采集请成批执行；施工 dig 只挖指定方块，绝不自动扩散，目的为 staircase 时按精确坐标清理。批量采集使用 mine_continuous（参数 {"pos":[x,y,z],"maxBlocks":6}）或 dig_many（参数 {"types":[方块名],"radius":半径,"limit":数量}，也可传 positions）。基础石料（石头、圆石、深板岩等）在普通计划中每种累计最多采集 12 块，没有明确用途时禁止反复囤积；只有为了当前楼梯、工具或建筑任务才使用 purpose="staircase"、purpose="mine" 或 bulk=true。
如果 layer_context.routeMemory 中存在 from/to 锚点路线，优先使用 route_navigate，参数为 {"from":"锚点名","to":"锚点名"}；首次记录路线时可以附带模糊 waypoints（坐标附近的点）。运行时会把不合法途经点替换为最近的合法站立点，合法原点保持不变，并过滤相距小于 5 格的中间点。锚点之间和途经点之间优先多用 move_to/route_navigate，避免每次重新规划复杂路线。
如果某条经常经过的路线附近地形长期凌乱、频繁导致寻路失败，可以在确认没有箱子、熔炉、工作台、岩浆或其他重要方块后使用 flatten_area 做小范围平整。参数为 {"center":[x,y,z],"radius":4,"targetY":y,"placeItem":"cobblestone","digTypes":["dirt","grass_block","stone"]}；这是低频维护任务，必须明确指定范围和方块，不要为了普通移动主动平整大面积地形。
navigation_recover 可按目标高差自动选择搭桥、梯子、向下楼梯或向上楼梯；bridge_to、ladder_climb、staircase_down、staircase_up 可直接指定方式，无需历史寻路失败。施工后复核实际位置并继续普通寻路。导航每次只处理一个目标工作；如果已有同一寻路任务正在执行或排队，不要重复提交。不要声称看到了 API 未提供的信息；禁止命令、管理员接口、读取世界存档或违反比赛规则的行为。任务应短小、可恢复。rationale 仅写简短决策依据摘要，不要输出隐藏的逐字内部推理。`;

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : text;
  return JSON.parse(candidate.trim());
}

export class OpenAICompatibleProvider {
  constructor({ baseUrl, apiKey, model, timeoutMs = 60000, fetchImpl = fetch, onTrace = () => {}, providerName = "distribution", conversationFile = null, conversationMaxTurns = 6, conversationMaxChars = 90000, sessionFile = "data/debug-session.json", ledgerFile = "data/llm-session-budget.json" }) {
    this.baseUrl = String(baseUrl || "").replace(/\/$/, "");
    this.apiKey = apiKey; this.model = model; this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl; this.onTrace = onTrace; this.providerName = providerName;
    this.conversations = new ConversationStore({ filePath: conversationFile, identity: `${this.baseUrl}:${model}`, maxTurns: conversationMaxTurns, maxChars: conversationMaxChars });
    this.inFlight = new Map();
    this.budget = new SessionBudget({ sessionFile, ledgerFile });
  }

  async complete(layer, system, request, temperature, { timeoutMs = this.timeoutMs, noThink = false } = {}) {
    if (!this.baseUrl || !this.apiKey || !this.model) {
      const missing = [!this.baseUrl && "模型地址", !this.apiKey && "API Key", !this.model && "模型名称"].filter(Boolean);
      throw Object.assign(new Error(`模型配置不完整：缺少${missing.join("、")}。请在启动控制中补充并点击启动以应用配置`), { code: "llm_not_configured" });
    }
    // Different layers remain concurrent; serialize only turns of one layer.
    const previous = this.inFlight.get(layer) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await this.conversations.load();
      const boundedSession = Boolean(this.budget.session()?.tokenBudget);
      const conversation = boundedSession ? { messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(request) }], retainedTurns: 0, compacted: true } : this.conversations.prepare(layer, system, request);
      const outputLimit = layer === "tac" ? 512 : layer === "reflection" ? 1400 : layer === "strategic" ? 2200 : 3000;
      const budgetTicket = this.budget.reserve(layer, conversation.messages, outputLimit);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const startedAt = Date.now();
      this.onTrace({ type: "llm-request", provider: layer, model: this.model, request, conversation: { retainedTurns: conversation.retainedTurns, compacted: conversation.compacted } });
      try {
        const response = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, temperature, response_format: { type: "json_object" }, messages: conversation.messages, ...(boundedSession ? { max_tokens: outputLimit } : {}), ...((boundedSession || noThink) && /deepseek/i.test(this.model + this.baseUrl) ? { thinking: { type: "disabled" } } : {}) })
        });
        if (!response.ok) throw new Error(`${layer} 模型 HTTP ${response.status}`);
        const body = await response.json();
        this.budget.settle(budgetTicket, body.usage);
        const content = body.choices?.[0]?.message?.content;
        this.onTrace({ type: "llm-response", provider: layer, usage: body.usage || null, model: body.model || this.model, content, durationMs: Date.now() - startedAt });
        if (typeof content !== "string" || !content.trim()) throw new Error("模型返回了空内容");
        const result = parseJson(content);
        try { await this.conversations.commit(layer, system, conversation.messages, content); }
        catch { this.onTrace({ type: "llm-storage-warning", provider: layer, error: { message: "对话记录保存失败，本轮决策仍可执行" } }); }
        return result;
      } catch (error) {
        const failure = error?.name === "AbortError" && controller.signal.aborted
          ? Object.assign(new Error(`${layer} 模型请求超时（${Math.round(timeoutMs / 1000)} 秒），已取消`), { code: "llm_timeout" })
          : error;
        this.onTrace({ type: "llm-error", provider: layer, error: { message: failure.message, code: failure.code }, durationMs: Date.now() - startedAt });
        throw failure;
      } finally { clearTimeout(timeout); }
    });
    this.inFlight.set(layer, pending);
    try { return await pending; }
    finally { if (this.inFlight.get(layer) === pending) this.inFlight.delete(layer); }
  }

  createPlan({ context, activePlan }) {
    return this.complete(this.providerName, SYSTEM_PROMPT, { layer: "distribution", layer_context: context, activePlan }, 0.2);
  }
  createAutomationPlan({ context, activePlan, noThink = false }) {
    const system = `你是 Minecraft Distribution，负责把长期 Strategy 与当前情况结合，分发完整的 C++ 自动化任务。只返回合法 JSON，使用中文简短摘要，不输出隐藏推理。
Distribution 只在没有工作或当前脚本即将结束时生成下一份工作；人工 debugHints 可立即触发重新分发。动作失败时本地会先无模型执行一次检查/安全恢复，不应自动重复失败任务。
最新用户目标与debugHints优先；钻石装备已穿戴时直接推进附魔，不重做早期阶段。早期生存按 layer_context.earlySurvivalFlow 和战略目标推进：8木头→工作台落地→木棍/木镐→6石头→石斧/石镐→累计32原木、4块肉并尽量收羊毛→斜向下→临时火柴盒基地→Y=40煤层鱼骨→Y=10铁层鱼骨→铁镐/盾牌→铁剑/铁甲。先核验真实库存、装备、坐标、工作区与已完成任务，选择第一个未完成且当前可行的阶段；不要反复做已完成阶段，不能仅凭计划文本判定完成。遇到原料不足，改派补料任务；地面应急工作台只解决缺工作台，不会补足配方原料。安全风险可暂停当前阶段，但不改变总体顺序。
你不操作单个方块、单个 API，不输出 dig/place/window_act/attack 等原始动作。只使用 layer_context.scriptCatalog 所列的完整脚本。尽量一次委派一个能长期自行运行的完整脚本；确有前后工序依赖时才追加后续工作。循环、观测、前置检查、取路、工具选择、合成依赖链和进度续跑全部由传统程序完成；不要拆成多个短任务交替请求模型。砍树和指定矿脉采集按 targetCount 停止；鱼骨不指定矿种、目标数量或时间预算。不要无限堆积石料，不重复当前正在执行或队列中已有的工作。
Strategy 只管长期路线，你负责当前工序。scriptCatalog 是接口参数示例，不是实际坐标；不能复制其中 [0,64,0] 等占位坐标。根据真实空间、库存、记忆、工作区与锚点规划。任务没有总超时参数。普通移动由 C++ 拆为约8到10格，剩余不足10格一次完成；不拆成大量2到3格，也不发几十格远目标给服务端一次搜索。地下远行先调整高度，再搭路或挖路。施工无需最近一次 move_to 失败。
insufficient_tool_tier 表示有镐但等级不足，不代表需要再造同等级石镐。钻石、红石等先用铁级以上工具；nativeState.deferredOres 保存暂不能采的矿物坐标和所需等级，换好工具后核实再回采。C++鱼骨遇到等级不足的旁支矿会记坐标、保留矿物并继续寻找可采资源。普通探矿已有健康石镐时不要因钻石采不了反复制造石镐；先按实际缺口采铁、熔炼和造铁镐。
战术新增阶段：铁装后至Y=-55，采钻石/金/青金石；基础31钻扣除实际已制装备和附魔台，以earlySurvivalFlow.diamondBudget缺口为准。之后扩建地下据点、铁桶、钻石工具全甲，尽量弓弩与有水有光的作物/甘蔗，黑曜石用于附魔台和地狱门，本轮不进入下界。路线可选附魔不取消当前专项的镐→剑→甲附魔目标。已有完整铁套或以上装备时禁止主动避开矿洞，旧avoidCaves:true/allowOpenSpace:false不能覆盖此规则。鱼骨和阶梯遇到可达矿洞立即进入C++探索模式，记录caveDetour，先探索、采裸露矿，完成后返回原检查点续同laneId或阶梯。液体不设邻近禁区：有实体隔层、不会挖穿引流即可施工，干燥落脚点邻水可通行；仅实际液体格、会挖穿液体边界或真实危险阻止当前施工。采集和矿洞脚本不得随地放箱或自动存红石、青金石等矿物，背包紧张只清允许的普通石料，确需存取时明确返回据点已有箱子。不要重置主道坐标或把局部边界误当成整项失败；补工具后沿原laneId和检查点继续。阶梯上下行也补采附近矿物；意外入水由C++先上浮换气、封顶找连通空气，再沿水面寻找有实体支撑的干燥岸边，确认in_water=false且on_ground=true才恢复原任务；露头或氧气恢复不算上岸，不要另派导航到水下旧落脚点。
workshop mode=craft 使用 items:[{item,count,total:true}]（达到背包总数）；mode=smelt 的 item 优先传原料名（如 raw_iron），也兼容成品名（如 iron_ingot，由C++按实际原料及已入炉批次解析），count 是本批产物数量，可选 fuel（煤、木炭、原木、木板、木棍；不填则自动选），原木可以烧出首批木炭。脚本会优先复用附近设施，背包已有熔炉可自动就近放置，清空旧成品、续烧已入炉原料并保存批次，不要因旧槽占用新建熔炉。mode=store|take 使用 items:[{item,count}]、可选 target:[x,y,z]；指定熔炉取物时可加 from:output|input|fuel，默认output。完整配方 DAG 只在本地执行；layer_context.craftReadiness 只给与你工作相关的可行性、缺口和加工步骤。missing 存在时先补料，processing 中 kind=smelt 必须单独熔炼，不能用 craft 代替。不要重复核算脚本已检查的每步原料，禁止把剑斧镐放副手，盾牌使用 off-hand；盔甲栏位为 head/torso/legs/feet。
砍树用一个 chop_tree 自动循环直到材料达到目标。鱼骨脚本按 laneId 维护固定主道与支道坐标，只在矿道完成、危险或缺少工具时退出；发现的任何可安全采集矿物都顺手采集，完成主道后才扩支道，任务过程中不得被 Distribution 重派任务打断。build_base 用于替换地下基地锚点：以当前位置为中心，先清空火柴盒施工体积，地板发现空气就用指定建筑方块补齐，然后依次封墙、封顶、放置工作台/熔炉/箱子并记录基地锚点；外观先保持朴素，后续再升级。build_workarea 只在确实需要旧式岩壁工作区时调用。合成配方由本地 DAG 预检整条链，确认材料足够后才按原料到成品顺序调用合成；缺料不调用合成。工作台缺失时可在任何可见、可放置且有支撑的位置放置，必要时开出位置，合成结束后回收临时工作台。mark_anchor 记录家/矿洞入口/矿层等；route_navigate 复用路线，验证当前落脚点。
只有队列空、工作即将结束、动作失败需重新委派或人工提示时才由调度器调用你；不要建议循环调用LLM、逐块指挥或重复inspect_state。queuedTasks 是已排队工作，不得重复安排。taskContinuity.mode=plan_next 时，当前脚本仍会继续执行，已有队列也会先完成；只安排它们全部完成后的工作，不重放当前脚本或队列，不继承当前任务ID，不把尚未获得的资源当作已经入包。提前量由程序根据实测耗时决定，不再固定为4秒。layer_context.control.forbiddenActions 是本地硬约束，绝不能输出其中脚本；仅按当前forbiddenActions执行限制；钻石材料齐备后的扩建/附魔不受旧的深层禁建规则影响。清槽只丢多余普通石料，矿物放补给箱。失败后读取 recentActionFailure，改变条件，禁止相同参数盲重试。earlySurvivalFlow 只包含当前与后续阶段，nativeState 只包含有效锚点/工作区/当前矿道概要；完整路径与路线恢复由本地程序负责，不要索要整个历史。memory.facts 是经筛选的工作记忆，Reflection 不作为工作上下文。没有安全有效工作时返回空 tasks 并解释等待原因。周围方块数量不是通路地图；工作区永久禁止挖掘，禁止提前进入下界、管理员命令或读取存档。远处或遮挡的敌对生物交给Tac判断，不中断普通工作去追击。
新脚本：explore_cave 在安全可站立矿洞中以中距移动探索并采裸露矿、收经验，targets是背包总目标（不是增量）；caveId必须复用nativeState.caveSurveys中的ID。entry可指定已实测入口；禁止将墙体/矿物nearest当入口。脚本持久化通道、侧分支、危险与回溯栈，不重走已扫描区域；surveyed_reachable_frontier只表示当前可达边界扫完，不能重复派同矿洞。gather_resources在地表寻找甘蔗（保留根）、牛皮；复用surveyId，targets同为总目标。建满15书架与附魔台共需46本书（138纸+46皮）、90木板、4黑曜石、2钻石，扣除已有书/书架；钻石剑另需2钻。优先利用实测可达矿洞暴露面，不继续盲挖深板岩。build_enchanting_area可选center（必须真实安全坐标；不填由脚本选当前位置旁），bookshelves:15；在相邻岩壁扩建5x5两格房间，保护现有设施。enchant_equipment可省target复用附魔区记录，minLevel默认30；脚本按钻石镐→钻石剑→四甲执行，已附魔跳过、经验不足返回缺口，盔甲换用背包旧铁甲后附魔再穿回，禁止把工具放副手。最终按实物enchantments确认，不能用成功动作代替。满级附魔每件需至少30级并消耗3级和3青金石，后续需继续补经验。所有脚本缺料警告应安排补料并续原进度，不反复重建。
JSON格式：{"rationale":"简短决策依据","priorities":["当前工序"],"tasks":[{"id":"标识","title":"工作名","goal":"可验证目标","actions":[{"type":"scriptCatalog中的脚本名","params":{}}]}]}。`;
    return this.complete("distribution", system, { layer: "distribution", layer_context: context, activePlan }, 0.1, { timeoutMs: 120000, noThink });
  }
  createStrategy({ context, activePlan, distribution = null }) {
    return this.complete("strategic", STRATEGIC_SYSTEM_PROMPT, { layer: "strategic", layer_context: context, activeStrategicPlan: activePlan, distribution }, 0.15);
  }
  createTactics({ context, combat = false }) {
    return this.complete("tac", `你是Minecraft快速Tac保活辅助，只返回JSON：{"urgent":false,"reason":"简短危险判断","responses":["shield|flee|shelter|eat|attack"]}。传统程序已触发emergency时会先执行短促攻击脚本，你负责后续逃跑、举盾、避险和恢复策略；combat=false时检查传统阈值没发现的组合危险（血量/氧气变化、敌对接近、无退路、环境）。没有实际风险时urgent=false。最多选3种响应；低血优先格挡撤离到验证过的位置，安全且有食物时才建议shelter/eat；不追远怪、不提供任意API参数。只根据观察判断，不输出隐藏推理。`, { context, combat }, 0.1, { timeoutMs: 3000 });
  }
  createReflection({ events = [], hints = [], currentPlan = null, strategicPlan = null, memoryArchive = null, environment = null }) {
    const system = `你是 Minecraft Agent 的 Reflection 层。请用中文总结经验教训，返回合法 JSON，格式为 {"document":"Markdown 文档","lessons":["经验"],"nextHints":["提示"]}。
只根据给定事件、observed实测状态和已有记忆判断成功与失败。observed里的库存和装备是最近实测证据，即使长脚本尚未返回，也可据此确认已经取得的资源；反之动作成功不能证明库存增加。不能把 API 格式错误、目标尚未到达或背包未变化说成成功。空间判断应区分脚部坐标、支撑、头部和额外净空；不得从方块数量推断可行走通路。发现相同错误重复时明确建议停止该参数并重新观察。保留仍然有效的经验，不重复粘贴全部历史，不输出隐藏推理。`;
    const compact = events.slice(-80).map(item => ({ at: item.at, type: item.type, layer: item.layer, label: item.label, detail: item.detail, action: item.action, error: item.error, durationMs: item.durationMs }));
    const stock = {};
    for (const item of environment?.inventory?.items || []) stock[item.name] = (stock[item.name] || 0) + (Number(item.count) || 0);
    const status = environment?.status || {};
    const observed = environment ? { at: environment.observedAt, position: status.pos, health: status.health, food: status.food, alive: status.alive, busy: status.busy, stock, held: status.held || environment.inventory?.held, armor: environment.inventory?.armor, offhand: environment.inventory?.offhand, emptySlots: environment.inventory?.empty_slots } : null;
    return this.complete("reflection", system, { layer: "reflection", observed, events: compact, hints: hints.slice(-30), currentPlan, strategicPlan, memories: memoryArchive?.entries?.slice(0, 16).map(entry => ({ kind: entry.kind, summary: entry.summary })) || [] }, 0.1);
  }
}

export class HeuristicStrategyProvider {
  async createStrategy({ snapshot }) {
    const status = snapshot.status || {};
    const hostile = snapshot.entities?.find(entity => (entity.type === "hostile" || entity.type === "monster") && isDirectCombatThreat(status, entity));
    return {
      mission: "先保证生存，再沿稳定路线持续积累资源和能力",
      horizon: "未来 10-30 分钟",
      objectives: [
        ...(hostile ? [{ id: "survive-threat", title: "处理近距离威胁", goal: "只处理近距离且可见的敌对生物", priority: 100, constraints: ["不要追击远处或被方块遮挡的目标"] }] : []),
        { id: "progress", title: "持续推进当前资源目标", goal: "完成当前 Distribution 正在执行的阶段任务", priority: 70, constraints: ["任务未完成且环境稳定时保持目标连续"] }
      ],
      route: ["修整区", "地表资源区", "矿洞入口"],
      risks: ["生命和食物下降", "岩浆、坠落和死亡掉落"],
      principles: ["优先复用已验证路线", "一次只推进一个主线工作", "普通石料按用途和配额采集"]
    };
  }

  async createPlan({ snapshot }) {
    const status = snapshot.status || {};
    const items = new Set((snapshot.inventory?.items || []).map(item => item.name));
    const hostile = snapshot.entities.find(entity => (entity.type === "hostile" || entity.type === "monster") && isDirectCombatThreat(status, entity));
    if (hostile) {
      return {
        rationale: "附近有敌对生物，先处理直接威胁，再继续收集资源。",
        priorities: ["生存", "战斗"],
        tasks: [{ id: `defend-${hostile.id}`, title: "处理附近敌对生物", goal: "确保战斗中存活", maxAttempts: 1, actions: [
          { type: "posture", params: { shield: items.has("shield") } },
          { type: "attack", params: { entity_id: hostile.id, timeout: 12000 } }
        ] }],
        delegation: []
      };
    }
    if (status.health && status.health < 14) {
      const food = ["cooked_beef", "cooked_porkchop", "bread", "baked_potato"].find(item => items.has(item));
      if (food) return { rationale: "生命值偏低，先补充食物恢复生命，再继续探索。", priorities: ["生存"], tasks: [{ id: "eat", title: "恢复生命", goal: "补充饥饿值并恢复生命", maxAttempts: 2, actions: [{ type: "use_item", params: { item: food, timeout: 10000 } }] }], delegation: [] };
    }
    return {
      rationale: "当前没有明显紧急危险；集中开采附近可见木头，一次任务批量收集多个方块。",
      priorities: ["生存", "资源收集"],
      tasks: [{ id: "gather-visible-wood", title: "批量收集附近木头", goal: "获得多块原木", maxAttempts: 2, actions: [
        { type: "dig_many", params: { types: ["oak_log", "birch_log", "spruce_log"], radius: 24, limit: 4 } }
      ] }],
      delegation: []
    };
  }
}


