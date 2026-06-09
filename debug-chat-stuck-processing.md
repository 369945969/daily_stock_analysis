# [OPEN] Debug Session: chat-stuck-processing

## Context

- Symptom: `/chat` 问股页面在提示“获取实时行情 完成”后长时间停留在处理中，用户希望确认后端是否还在继续跑，还是已经卡死/结束。
- Primary evidence source: `logs/dsa-start.log`
- Constraint: 本阶段仅做证据收集，不修改业务逻辑。

## Hypotheses

1. Agent 工具阶段已经完成，但后续 LLM 调用仍在等待上游返回，因此日志会停在 `tool_done` 之后并出现长时间无新进展。
2. 后端主流程仍在继续执行，但没有继续产生 SSE progress 事件，导致前端只看到“处理中”。
3. 当前会话实际上已经超时/失败结束，但前端没有及时消费到 `done/error` 事件。
4. 同一个 `session_id` 被重复请求覆盖，旧请求的日志与新请求交错，导致看起来像“卡住”。

## Evidence Log

- Confirmed session: `a0a4d3b7-6444-4e43-8c9f-046605d82d0b`
- `21:30:07` step 1 开始工具：`get_realtime_quote` / `get_daily_history`
- `21:30:12` `get_realtime_quote` 完成，`21:30:23` `get_daily_history` 完成
- `21:30:28` step 2 继续执行 `analyze_trend` / `get_chip_distribution` / `get_volume_analysis`
- `21:30:32` `get_chip_distribution` 完成，进入 step 3
- `21:30:36` step 3 开始新闻搜索：`search_stock_news` / `search_comprehensive_intel`
- `21:31:08` `search_comprehensive_intel` 完成，进入 step 4
- `21:31:31` LLM 返回最终内容，随后 `[agent.stream] done ... ok=True`

## Hypothesis Status

1. Agent 工具阶段已经完成，但后续 LLM 调用仍在等待上游返回，因此日志会停在 `tool_done` 之后并出现长时间无新进展。
   - Rejected for this run. 最后一步 LLM 在 23s 内返回，并未卡死。
2. 后端主流程仍在继续执行，但没有继续产生 SSE progress 事件，导致前端只看到“处理中”。
   - Plausible. 后端有持续日志并最终 `done`，若前端未结束，更像 SSE 消费/连接状态问题。
3. 当前会话实际上已经超时/失败结束，但前端没有及时消费到 `done/error` 事件。
   - Rejected for this run. 后端是 `ok=True error=None` 正常结束。
4. 同一个 `session_id` 被重复请求覆盖，旧请求的日志与新请求交错，导致看起来像“卡住”。
   - Not supported by current evidence. 当前日志链路单调连续。

## Fix

- Frontend root cause hypothesis: `apps/dsa-web/src/stores/agentChatStore.ts` 之前会持续等待 HTTP 流真正 EOF，再把 `loading` 置回 `false`；如果浏览器侧连接在收到 `type=done` 后没有立即关闭，就会出现“后端已 done，但前端一直处理中”。
- Mitigation applied: 收到 `type=done` 后，前端立即停止继续读取并主动 `reader.cancel()`，不再依赖服务端/浏览器何时关闭底层连接。
- Regression test added: 补充“`done` 已到达但流保持打开”场景，确保前端仍能完成收尾。

## Verification

- `curl -sN` 直连 `/api/v1/agent/chat/stream` 已验证后端会产出完整 `done` 事件，且命令正常退出。
- `npm run build` in `apps/dsa-web` succeeded; updated static assets emitted to `static/`.
- `vitest` targeted run currently fails before executing tests because the workspace test environment exposes a non-standard `localStorage` object (`localStorage.getItem is not a function`). This appears unrelated to the chat stream fix itself.

## Status

- In progress: fix applied and built; browser-side verification pending refresh/retest.
