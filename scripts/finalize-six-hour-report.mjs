import { readFile, writeFile, appendFile, readdir, copyFile } from 'node:fs/promises';

const read = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, value) => writeFile(p, JSON.stringify(value, null, 2) + '\n');
const session = await read('data/debug-session.json');
const state = await (await fetch('http://127.0.0.1:4173/api/debug/state', { signal: AbortSignal.timeout(15000) })).json();
const native = await read('data/native-state.json');
const now = Date.now();
const counts = {};
for (const item of state.environment?.inventory?.items || []) counts[item.name] = (counts[item.name] || 0) + item.count;
const evidence = {
  at: now, status: state.status, workerPid: state.supervisor?.workerPid,
  bot: state.environment?.status, inventory: state.environment?.inventory, counts,
  environmentObservedAt: state.environment?.observedAt,
  action: state.layers?.action, automation: state.automation, tokenUsage: state.tokenUsage,
  spatial: state.environment?.spatial, reflection: state.reflection,
  lane: native.fishboneRoutes?.['fishbone:50'], session,
};
await save('data/debug-inspection-20261115-final.json', evidence);
if (process.argv.includes('--snapshot')) {
  console.log(JSON.stringify({ at: now, deadline: session.deadline, position: evidence.bot?.pos, diamond: counts.diamond, armor: evidence.inventory?.armor, status: state.status, pid: evidence.workerPid }));
  process.exit(0);
}
if (now < session.deadline || state.supervisor?.workerPid || state.status !== 'stopped') throw new Error('尚未到截止时间或Agent尚未停止，拒绝生成最终版');

const files = await readdir('data');
const sources = files.filter(p => p === 'runtime-events.jsonl' || p === 'runtime-events.jsonl.previous').map(p => `data/${p}`);
const eventCounts = {}, rawEventCounts = {}, errors = {}, seen = new Set();
let invalidLines = 0, firstAt = Infinity, lastAt = 0;
for (const source of sources) {
  for (const line of (await readFile(source, 'utf8')).split(/\r?\n/).filter(Boolean)) {
    let e; try { e = JSON.parse(line); } catch { invalidLines++; continue; }
    if (e.at < session.startedAt || e.at > session.deadline) continue;
    rawEventCounts[e.type] = (rawEventCounts[e.type] || 0) + 1;
    if (seen.has(line)) continue;
    seen.add(line); eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    firstAt = Math.min(firstAt, e.at); lastAt = Math.max(lastAt, e.at);
    if (/error|warning/.test(e.type)) {
      const code = e.warning?.result?.code || e.warning?.code || e.error?.code || e.result?.code || e.code || 'unknown';
      errors[code] = (errors[code] || 0) + 1;
    }
  }
}
let onlineHealthSamples = 0, onlineRunningSamples = 0;
for (const line of (await readFile('data/overnight-progress.jsonl', 'utf8')).split(/\r?\n/).filter(Boolean)) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.at >= session.startedAt && e.at <= session.deadline && e.type === 'health' && e.status === 'online') {
    onlineHealthSamples++;
    if (e.action?.status === 'running') onlineRunningSamples++;
  }
}
const ratio = onlineRunningSamples / Math.max(1, onlineHealthSamples);
const metrics = {
  asOf: now, status: 'final', startedAt: session.startedAt, deadline: session.deadline, sources,
  eventCoverage: { firstAt, lastAt }, invalidLines, eventCounts, rawEventCounts, errors,
  onlineHealthSamples, onlineRunningSamples, sampledRunningShare: ratio,
  sampleCaveat: '约30秒状态采样，非精确时长；running含API等待，可能含UI旧快照。',
  deduplication: '事件按完整JSON行去重；rawEventCounts保留重复行。',
  tokenCheckpoint: state.tokenUsage,
  tokenCaveat: '当前持久累计，不是六小时增量；缺少窗口起点完整Token基线；Reflection单列。',
};
await save('data/six-hour-metrics-20261115.json', metrics);
const armor = evidence.inventory?.armor || {};
const fullDiamond = ['head', 'chest', 'legs', 'feet'].every(k => /^(diamond|netherite)_/.test(armor[k]?.name || ''));
const missing = [['head', 5], ['chest', 8], ['legs', 7], ['feet', 4]].reduce((n, [k, amount]) => n + (/^(diamond|netherite)_/.test(armor[k]?.name || '') ? 0 : amount), 0);
const t = state.tokenUsage || {}, reflection = t.byProvider?.reflection || {};
const clock = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const pct = value => `${(100 * value).toFixed(1)}%`;
const archive = 'docs/six-hour-rounds-20261115.md';
try { await readFile(archive); } catch { await copyFile('docs/six-hour-report-20261115.md', archive); }
const report = `# Minecraft Agent 六小时调试最终报告

状态：最终版。窗口为北京时间 ${clock(session.startedAt)} 至 ${clock(session.deadline)}。Agent已停止，UI保留；最后核验 ${clock(now)}。本报告仅依据实际观测，历史轮次记录见 [逐轮记录](six-hour-rounds-20261115.md)。

## 实际结果

- 全套钻石甲：${fullDiamond ? '已实际穿戴' : '未完成'}。最后背包散钻 ${counts.diamond || 0} 颗，按缺失甲件还需 ${Math.max(0, missing - (counts.diamond || 0))} 颗材料；${counts.diamond_pickaxe || 0} 把钻石镐。已消耗的补镐钻石不计作现有库存。
- 最后穿戴：${Object.values(armor).map(x => x.name).join('、')}；副手 ${evidence.inventory?.offhand?.name || '无'}。面包 ${counts.bread || 0}，饱食 ${evidence.bot?.food}。
- 位置 ${JSON.stringify(evidence.bot?.pos)}，维度 ${evidence.bot?.dimension}。本轮未进入下界；地狱门和小家美化未完成。
- 地下临时基地与工作台、熔炉、箱子已有记录；旧封闭出口已修复并实际走出。基地属于功能性临时据点，不计作美化小家完成。
- 最后持续执行 lane50 鱼骨脚本。停止前的任务和矿道进度保存在本地，未因短期无钻收益另开矿道。最终矿道摘要：mainStep=${evidence.lane?.mainStep ?? '见native-state'}，branchHub=${evidence.lane?.branchHub ?? '见native-state'}。

## 主要修复与验证

| 问题 | 已部署处理 | 验证边界 |
| --- | --- | --- |
| 无效分发、重复入队与上下文污染 | 合并请求入队、同计划去重、恢复空队列唤醒；记忆与Reflection分离，保留当前矿道摘要 | 最新长任务持续运行；历史总Token仍高，不能宣称全部消除 |
| 鱼骨只延伸主道、局部风险结束整任务 | 同矿道32格主道分段扩支道、持久化端点/进度；普通通道两格高；局部空腔/岩浆/高砂砾结束对应分支 | 实机已跨多处局部边界继续原矿道 |
| 工具耗尽、矿物拾取后卡位 | 本地补镐、按等级选工具、遇矿连采、拾矿后回施工站位、短落差恢复与回填 | 实际采得钻石并补造钻石镐；新多层侧槽恢复尚未完整实机捕获 |
| 工作站放置/交互与DAG合成 | 安全放置/换侧、缓存检查、整批合成后回收、预检原料、混合木板、熔炼成品名与批次兼容 | 实际熔炼铁、穿戴铁甲、就地合成补给；普通place自身占格新分支待实机 |
| 满包停工、重复旧设施报错 | 满包不等待开挖计数；红石/青金石9:1压缩；单次最多64块；跳过未加载旧工作站 | 实机红石块64、空槽0→10、工作台回收并恢复原lane；64批次上限修订仅模拟覆盖 |
| 战斗后原鱼骨不恢复 | Tac结束直接恢复同task/plan/lane及后续依赖队列 | 10项相关检查通过、部署恢复真实施工；部署后尚未再次发生战斗触发 |
| 达24钻后长任务不交接 | 按缺失甲件与现有高阶装备核算材料；达标保留路线并正常交接合成 | 24项相关检查通过；${fullDiamond ? '最终装备以实际栏位为准' : '实际未达材料门槛，未验证真实达标交接'} |
| 整树树冠砍不完 | 参考TLM/Maid Useful Tasks边砍边垫高、顶部收尾、拆柱下降、中断恢复 | 12格高树模拟通过；真实高树及跨多柱宽树冠仍待验证 |

修复批次均采用相关检查、临时编译、UI停止/替换/重启，并核对PID、文件哈希和实际动作。末批Worker由33396变为668；部署后原矿道真实恢复。本轮最终观察未改代码、未额外测试或重启健康任务。详细编译及验证证据见 [调试流水](overnight-debug.md) 与 data/debug-inspection-20261115-*.json。

公开源码研究与版本记录见 [源码参考](skill-research-20261115.md)。仅使用公开赛事API，没有读取世界存档。

## 自动化与Token

- 六小时窗口在线health样本 ${onlineHealthSamples} 个，其中action为running ${onlineRunningSamples} 个，占 ${pct(ratio)}。这是约30秒抽样，包含API等待和可能的UI旧快照，不能等同精确自动化时长。
- 最后Worker窗口脚本占比 ${pct(state.automation?.busyRatio || 0)}，仅覆盖该次启动；不能用它代替六小时占比。本次启动窗口以长脚本执行为主；原鱼骨达标后交接合成，装备完成再恢复同一矿道，避免了每格LLM分发。
- 主线持久累计 ${t.total?.toLocaleString('en-US')} Token / ${t.requests} 请求；Strategy ${t.byProvider?.strategic?.requests} 次，Distribution ${t.byProvider?.distribution?.requests} 次。Reflection另计 ${reflection.total?.toLocaleString('en-US')} Token / ${reflection.requests} 次。缺少六小时起点完整基线，以上不是六小时净消耗。
- 窗口去重事件：动作错误 ${eventCounts['action-error'] || 0}、动作警告 ${eventCounts['action-warning'] || 0}、Distribution错误 ${eventCounts['distribution-error'] || 0}。这些包含修复前历史，不代表最后长任务仍反复报错。统计方法及覆盖时间见 data/six-hour-metrics-20261115.json。

## 未完成与后续重点

1. ${fullDiamond ? '继续核实装备维护、补给和返程。' : '继续同lane安全采矿，补足钻石后实测材料达标交接、DAG合成与四件穿戴。'}不要凭成功文本认定装备完成。
2. 实测战斗后直接续跑、复杂落差恢复、高树升降和普通place换位；完善跨多柱树冠。
3. Reflection仍会误判长脚本progress为重复启动、建议换道或丢受保护矿物；保持仅作调试资料，改进其事实筛选并降低无效总结消耗。
4. 历史分发与Token总量仍高；应继续减少失败后的无效规划，并进一步用可靠C++恢复替代重复LLM请求。
5. 地狱门、漂亮小家未完成，尚不进入下界。
6. QQ未验证送达，未重试旧NCB-apo目标，不能声称远程通知可用。

最终证据：[实机快照](../data/debug-inspection-20261115-final.json)、[统计](../data/six-hour-metrics-20261115.json)、[逐轮记录](six-hour-rounds-20261115.md)。界面停止后保留的背包/位置为最后一次公开观测，不是停止后重新登录采集。
`;
await writeFile('docs/six-hour-report-20261115.md', report);
const summary = `\n\n## 六小时截止收尾（${clock(now)}）\n\nAgent停止、UI保留，Worker PID为空。散钻${counts.diamond || 0}，全钻石甲${fullDiamond ? '已穿戴' : '未完成'}；主世界位置${JSON.stringify(evidence.bot?.pos)}。最终报告、逐轮归档、窗口统计和实机快照已写入。QQ仍未验证送达。最后观察轮未修改代码或重启；后续待办见最终报告。\n`;
await appendFile('docs/overnight-debug.md', summary);
await appendFile('data/overnight-progress.jsonl', JSON.stringify({ at: now, type: 'final-report', report: 'docs/six-hour-report-20261115.md', diamond: counts.diamond || 0, fullDiamond, workerPid: evidence.workerPid, status: state.status, sampledRunningShare: ratio }) + '\n');
console.log(JSON.stringify({ report: 'docs/six-hour-report-20261115.md', diamond: counts.diamond, fullDiamond, onlineHealthSamples, onlineRunningSamples, status: state.status }));
