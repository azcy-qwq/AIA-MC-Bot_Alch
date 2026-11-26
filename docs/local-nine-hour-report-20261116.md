# 本地 Minecraft 九小时连续调试报告

开始时间：2026/11/16 01:13:02

本轮环境：全新本地 Minecraft 1.21.11 世界、API 18900/18901、完整 Agent 4173 与 TAC-only 对照 4174。

## 当前已知问题

- 初始早期流程曾在树冠悬空后把非落脚点交给普通寻路，出现 60 秒 timeout；随后已记录为本轮重点回归项。
- TAC 改进副本的 40 项专项测试已通过；其“救援失败后暂停门槛”与默认 TAC 存在行为差异，等待真实危险窗口对照后再决定替换。

## 采样

### 2026/11/16 01:13:02

```json
[
  {
    "at": 1794762782808,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -15.5,
      77,
      4.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": "dig",
    "action": "chop_tree · tree_harvest · 入包 8/8 · 6 块",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 264,
    "runtimeEvents": 1,
    "lastError": null
  },
  {
    "at": 1794762782811,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      6.5,
      69,
      -5.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "",
    "tac": "monitoring",
    "tacDetail": "",
    "toolCalls": 0,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 01:43:08

```json
[
  {
    "at": 1794764588044,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      4.3,
      70,
      -2.3
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": "move_to",
    "action": "chop_tree · navigate · 入包 undefined/undefined · 0 块",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794764588047,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      7.5,
      77,
      10.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 02:13:09

```json
[
  {
    "at": 1794766389950,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      2.5,
      70,
      -0.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "缺少可安全搭路的方块",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794766389953,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      7.5,
      77,
      10.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 02:43:11

```json
[
  {
    "at": 1794768191887,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      2.5,
      70,
      -0.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "缺少可安全搭路的方块",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794768191891,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      6.5,
      69,
      -6.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 03:13:14

```json
[
  {
    "at": 1794769994111,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794769994116,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      -5.5,
      77,
      1.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 271ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 03:43:16

```json
[
  {
    "at": 1794771796221,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794771796226,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      -5.5,
      77,
      1.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 271ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 04:13:18

```json
[
  {
    "at": 1794773598548,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794773598553,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      0.4,
      70,
      4.7
    ],
    "health": 6,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "alert",
    "tacDetail": "low_health",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 04:43:20

```json
[
  {
    "at": 1794775400798,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794775400804,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      1.6,
      70,
      4.7
    ],
    "health": 4,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "alert",
    "tacDetail": "low_health",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 05:13:23

```json
[
  {
    "at": 1794777203012,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794777203017,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      4.5,
      73,
      7.4
    ],
    "health": 9.333332061767578,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "alert",
    "tacDetail": "low_health",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 05:43:25

```json
[
  {
    "at": 1794779005445,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794779005450,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      4.5,
      73,
      7.4
    ],
    "health": 9.333332061767578,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 276ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 06:13:27

```json
[
  {
    "at": 1794780807766,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794780807770,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      5.7,
      69,
      5.5
    ],
    "health": 13.333332061767578,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "tac · survive",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 06:43:29

```json
[
  {
    "at": 1794782609911,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794782609916,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      9.6,
      69,
      3.3
    ],
    "health": 12.333332061767578,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 300ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 07:13:32

```json
[
  {
    "at": 1794784412124,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794784412127,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      -7.5,
      80,
      -5.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 149391ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 07:43:34

```json
[
  {
    "at": 1794786214265,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794786214269,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      -7.5,
      80,
      -5.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 149391ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 08:13:36

```json
[
  {
    "at": 1794788016564,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794788016569,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      -7.5,
      80,
      -5.5
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 149391ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 08:43:38

```json
[
  {
    "at": 1794789818794,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794789818797,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      7.1,
      73,
      8.2
    ],
    "health": 20,
    "food": 20,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "角色死亡，交由恢复程序",
    "tac": "danger",
    "tacDetail": "等待重生",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 09:13:41

```json
[
  {
    "at": 1794791621058,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794791621062,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      3.7,
      69,
      10.2
    ],
    "health": 10,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 263ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

### 2026/11/16 09:43:43

```json
[
  {
    "at": 1794793423190,
    "port": 4173,
    "status": "online",
    "mode": null,
    "worker": 43372,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794793423194,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      3.7,
      69,
      10.2
    ],
    "health": 10,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 263ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```

## 九小时窗口结束

结束时间：2026/11/16 10:13:15

```json
[
  {
    "at": 1794795195241,
    "port": 4173,
    "status": "stopped",
    "mode": null,
    "worker": null,
    "username": "Licphel",
    "pos": [
      -2.5,
      59,
      -1.5
    ],
    "health": 16.16666603088379,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "没有可达树木或中距探索位置",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 3,
    "lastError": null
  },
  {
    "at": 1794795195247,
    "port": 4174,
    "status": "online",
    "mode": "tac-only",
    "worker": 43688,
    "username": "TacCompare",
    "pos": [
      3.7,
      69,
      10.2
    ],
    "health": 10,
    "food": 17,
    "alive": true,
    "ready": true,
    "busy": null,
    "action": "survive · 执行 263ms",
    "tac": "monitoring",
    "tacDetail": "紧急处置结束",
    "toolCalls": 300,
    "runtimeEvents": 1,
    "lastError": null
  }
]
```
