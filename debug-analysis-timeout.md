[# OPEN] debug-analysis-timeout

## Symptom
- “问股/分析”接口前端提示：请求失败 / 分析超时

## Goal
- 找到超时发生的具体位置（前端 → API → 任务队列 → LLM → 数据源），并给出最小修复。

## Hypotheses (falsifiable)
- A: 前端请求在浏览器侧超时/取消（轮询间隔、Abort、超时设置、并发导致卡死）。
- B: 后端 API 层超时（Uvicorn/Starlette 超时、中间件、反向代理、请求体过大或连接断开）。
- C: 任务队列/分析任务在后台仍在跑，但状态轮询一直拿不到完成（任务状态写入/读取异常、taskId 丢失、异常被吞）。
- D: LLM 调用超时或路由错误导致长时间阻塞（LiteLLM/Agent orchestrator budget、provider/base_url 不匹配、fallback 反复重试）。
- E: 数据源拉取阻塞导致整体超时（行情/历史数据源超时、重试过多、单点卡死）。

## Evidence Plan
- 启动 Debug Server，给关键路径加“只上报不改逻辑”的埋点：
  - 前端：发起分析、轮询状态、收到结果/错误
  - 后端：分析入口、任务入队/出队、状态变更、LLM 调用开始/结束/异常

## Runs
- pre: 触发分析后任务卡在 progress=18（正在获取行情与筹码数据），chip_distribution 在 AkshareFetcher 上出现“start 有 / end 无”的挂起迹象
- post: 增加 fetcher 调用硬超时保护后，progress 可推进到 32/58 等后续阶段（不再在 18 阶段无限挂起）

## Evidence (key points)
- Task progress 在 18 阶段停留：`600519：正在获取行情与筹码数据`
- chip_distribution：
  - `TushareFetcher` 93ms 返回 inconclusive
  - `AkshareFetcher` 出现挂起迹象（仅看到 attempt start）

## Notes
- Debug artifacts:
  - .dbg/analysis-timeout.env
  - .dbg/trae-debug-log-analysis-timeout.ndjson
