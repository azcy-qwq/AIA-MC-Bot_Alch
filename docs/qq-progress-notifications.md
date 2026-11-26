# QQ 进度通知

消息使用 SI 人设的简短中文口吻：称呼“管理员”，一段说明实际工作、阶段和重点资源，必要时补一句问题或下一步。不使用动作旁白，不虚构进展；固定程序模板生成，不调用模型。

实现位于 `scripts/progress-notify.js`，`scripts/overnight-watch.js` 每约 30 分钟检查发送间隔。停止、未知状态及超过一分钟未更新的观测分别明确表述，历史报错不当作当前结论。原始日志、坐标明细及零值资源不直接发送。

## 接收绑定待确认

2026-11-15 检查：AstrBot 的 `SI` 官方 QQ 适配器存在，当前 Key 可以访问 `GET /api/v1/im/bots`。旧配置指向未连接的 `NCB-apo`，已清空旧接收会话并关闭通知，避免误发。

官方 QQ 必须使用 `SI:FriendMessage:<机器人专属 openid>`，不能使用普通 QQ 号。用户已发送“Minecraft进度绑定”，但当前持久化历史未记录此消息；实时日志接口 `GET /api/v1/logs/history` 返回 403。下一步需要为现有 Key 开启 `system` 读取权限，或取得 AstrBot 中该绑定消息的确切私聊会话标识，再填入本机 `data/progress-notify.json` 的 `umo` 并开启 `enabled`。

取得准确会话前，不向现有的其他会话试发。Key 只保留在本机配置，不写入文档或消息。接口接受发送只表明请求成功，实际收件还需用户确认。

已验证语法检查，以及在线、停止、报错、过期观测和缺省状态的本地消息预览；尚未向 SI 发送测试消息。

用户随后提供的错误栈确认是 2026-11-15 01:08:50 的旧请求：目标 NCB-apo:FriendMessage:<QQ号>，调用 AiocqhttpAdapter，最终 aiocqhttp.exceptions.ApiNotAvailable。该栈不是 SI 官方 QQ 发送结果，不能据此认为已发出测试。已复查当前 enabled=false、umo为空、Key仍保留，旧目标不会继续发送。
