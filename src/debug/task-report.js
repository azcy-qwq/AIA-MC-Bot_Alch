import {appendFile, readFile} from 'node:fs/promises';
import path from 'node:path';

// Local reporting only: task results never cause an additional model call.
export async function appendTaskReport(kind, event, snapshot) {
  const session=JSON.parse(await readFile('data/debug-session.json','utf8'));
  if(!session.active||Date.now()>session.deadline||!session.reportFile)return;
  const root=path.resolve('docs'),file=path.resolve(session.reportFile);
  if(!file.startsWith(root+path.sep))return;
  const clean=value=>String(value??'').replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi,'[已隐藏]').replace(/[\r\n|]/g,' ').slice(0,180);
  const env=snapshot?.environment||{},status=env.status||{},task=snapshot?.workQueue?.running?.task?.title||event.task?.title||event.taskId||'任务';
  const counts=Object.fromEntries(['diamond','sugar_cane','leather','obsidian'].map(name=>[name,(env.inventory?.items||[]).filter(i=>i.name===name).reduce((sum,i)=>sum+i.count,0)]));
  const at=new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
  const result=kind==='task-complete'?'完成':kind==='task-error'?'失败':'警告';
  const reason=event.error?.code||event.warning?.code||'';
  await appendFile(file,`| ${at} | ${clean(task)} | ${result} ${clean(reason)} | 最近观测 ${clean(JSON.stringify(status.pos))}，XP ${status.xp_level??'?'}；钻 ${counts.diamond} / 甘蔗 ${counts.sugar_cane} / 皮 ${counts.leather} / 黑曜石 ${counts.obsidian} |\n`);
}
