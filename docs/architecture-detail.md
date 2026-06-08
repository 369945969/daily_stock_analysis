# 项目架构详解

本文档详细分析 `daily_stock_analysis` 的代码结构、Agent 交付流程、工具注册机制、暴露的 API 及前后端交互链路。

---

## 1. 整体架构

系统采用分层架构，自底向上为：

| 层 | 目录 | 职责 |
|---|---|---|
| 数据层 | `data_provider/` + `src/storage.py` + `src/repositories/` | 多数据源抓取（含 failover/circuit-breaker）+ SQLite 持久化 + 数据访问 |
| 服务层 | `src/services/` | 业务逻辑：分析、通知、搜索、回测、组合、告警等 |
| 核心层 | `src/core/` | 流程编排（pipeline）、大盘复盘、交易日历、配置管理 |
| Agent 层 | `src/agent/` | LLM+工具 ReAct 循环、多 Agent 协调、技能系统、深度研究 |
| API 层 | `api/` | FastAPI REST + SSE 流式推送 |
| Bot 层 | `bot/` | 多平台聊天机器人（钉钉/飞书/Discord）+ 自然语言路由 |
| 前端层 | `apps/dsa-web/` | React SPA（Vite + Zustand + React Router） |
| 桌面端 | `apps/dsa-desktop/` | Electron 桌面应用 |
| 入口 | `main.py` / `server.py` | CLI/调度器 / FastAPI-only 启动 |

两条分析路径：
- **传统路径**（非 Agent）：`StockAnalysisPipeline.analyze_stock()` → `GeminiAnalyzer.analyze()`（单次 LLM 调用）
- **Agent 路径**：`StockAnalysisPipeline.analyze_stock()` → `_analyze_with_agent()` → `build_agent_executor()` → 单 Agent ReAct 循环或多 Agent 编排

---

## 2. Agent 交付流程

### 2.1 单 Agent 模式（`AgentExecutor`）

文件：`src/agent/executor.py`

流程：

1. 构建系统 prompt：注入角色、市场角色（A 股/港股/美股不同 prompt）、技能指令、语言段
2. 构建 OpenAI 格式工具声明：`tool_registry.to_openai_tools()`
3. 构造用户消息：包含股票代码、报告类型、市场阶段上下文、预取上下文数据
4. 调用 `run_agent_loop()` 进入 ReAct 循环
5. 循环中：LLM 返回 `tool_calls` → 执行工具 → 结果回填 → 继续循环；无 `tool_calls` → 最终答案
6. 解析最终输出为 Dashboard JSON 或自然语言

两种入口：
- `run()`：Dashboard 分析模式，输出 JSON 报告
- `chat()`：聊天模式，加载历史会话，输出自然语言，通过 `conversation_manager` 持久化会话

### 2.2 多 Agent 模式（`AgentOrchestrator`）

文件：`src/agent/orchestrator.py`

四档编排模式（`AGENT_ORCHESTRATOR_MODE` 配置）：

| 模式 | Agent 串联 | LLM 调用次数 |
|---|---|---|
| `quick` | Technical → Decision | 2 |
| `standard` | Technical → Intel → Decision | 3 |
| `full` | Technical → Intel → Risk → Decision | 4 |
| `specialist` | Technical → Intel → Risk → SkillAgents → Decision | 4+ |

流程：

1. 创建 `AgentContext`（共享状态袋：query、stock_code、data dict、opinions 列表、risk_flags）
2. 按模式依次运行各 Agent，每个 Agent：
   - `BaseAgent.run()` → `_build_messages()` → `run_agent_loop()` → `post_process()` → 生成 `AgentOpinion`
   - 每个 Agent 只能访问自己的工具子集（`_filtered_registry()`）
3. 在 `specialist` 模式中，`SkillRouter` 动态选择最多 3 个技能 Agent 插入 Decision 前
4. `SkillAggregator` 合并技能 Agent 意见为加权共识
5. `DecisionAgent` 无工具访问（max_steps=3），综合所有意见 + 风险标记，输出最终 Dashboard JSON
6. `_resolve_final_output()` 尝试解析 JSON；失败则从意见合成 fallback Dashboard
7. `_apply_risk_override()` 可在 `agent_risk_override=True` 时将买入信号降级

### 2.3 各 Agent 详解

#### TechnicalAgent（`src/agent/agents/technical_agent.py`）

- 职责：技术分析（趋势、均线、MACD、RSI、量价、形态）
- 工具：`get_realtime_quote`, `get_daily_history`, `analyze_trend`, `calculate_ma`, `get_volume_analysis`, `analyze_pattern`, `get_chip_distribution`, `get_analysis_context`
- 最大步数：6
- 输出：JSON 意见（signal, confidence, key_levels, trend_score, ma_alignment, volume_status, pattern）

#### IntelAgent（`src/agent/agents/intel_agent.py`）

- 职责：情报搜索（新闻、综合情报、资金流向）
- 工具：`search_stock_news`, `search_comprehensive_intel`, `get_stock_info`, `get_capital_flow`
- 最大步数：4
- 输出：JSON 意见（signal, confidence, reasoning, risk_alerts, positive_catalysts, sentiment_label, capital_flow_signal）

#### RiskAgent（`src/agent/agents/risk_agent.py`）

- 职责：风险筛查（内幕、盈利预警、监管、解禁、估值极端、技术警告）
- 工具：`search_stock_news`, `get_realtime_quote`, `get_stock_info`
- 最大步数：4
- 输出：JSON 意见（risk_level, risk_score, flags, veto_buy, signal_adjustment）
- 高严重度风险标记可否决买入信号

#### DecisionAgent（`src/agent/agents/decision_agent.py`）

- 职责：综合所有意见，输出最终 Dashboard
- 无工具访问，max_steps=3
- 信号权重指南：Technical 40%, Intel 30%, Risk 30%, Skills 20%

#### SkillAgent（`src/agent/skills/skill_agent.py`）

- 职责：执行单个技能评估
- 由 Orchestrator 在 specialist 模式动态插入
- 每个技能是一个 YAML 定义的交易分析模块

### 2.4 ReAct 循环核心（`src/agent/runner.py`）

`run_agent_loop()` 是所有 Agent 共用的唯一执行循环：

1. 构建 `tool_registry.to_openai_tools()` 工具声明
2. 每步（最多 `max_steps`，默认 10）：
   - 检查墙钟超时预算（`_MIN_STEP_BUDGET_S = 8.0` 最小保障）
   - 发送 `thinking` 进度回调
   - 调用 `llm_adapter.call_with_tools()` 带超时
   - 持久化 LLM usage
   - 有 `tool_calls` → 并行执行（ThreadPoolExecutor，最多 5 线程） → 结果回填 → 继续循环
   - 无 `tool_calls` → 返回 `RunLoopResult`
3. 超过 `max_steps` → 返回失败结果

工具执行细节：
- 单工具：内联执行 + 可选超时
- 多工具：并行执行（`as_completed()`）+ 批次超时
- 不可重试工具结果缓存
- 每次工具调用记录：step, name, arguments, success, duration, result_length

---

## 3. 工具注册与使用机制

### 3.1 注册框架（`src/agent/tools/registry.py`）

核心类：

- `ToolParameter`：参数定义（name, type, description, required, default）
- `ToolDefinition`：工具定义（name, description, parameters, handler, category）
  - `to_openai_tool()`：生成 OpenAI 格式工具 schema
  - 支持 Gemini 命名空间规范化（`default_api:get_realtime_quote` → `get_realtime_quote`）
- `ToolRegistry`：注册中心
  - `register(tool_def)`：按 name 存储
  - `execute(name, **kwargs)`：调用 handler
  - `list_tools(category)`：按类别列出
  - `to_openai_tools()`：生成全部 OpenAI 格式声明供 LLM 使用
  - 全局单例 `_default_registry`

`@tool` 装饰器：自动注册函数为工具，从类型提示推断参数定义

### 3.2 工具工厂（`src/agent/factory.py`）

`get_tool_registry()`：
- 模块级缓存单例
- 注册所有工具类别：`ALL_DATA_TOOLS` + `ALL_ANALYSIS_TOOLS` + `ALL_SEARCH_TOOLS` + `ALL_MARKET_TOOLS` + `ALL_BACKTEST_TOOLS`
- 各 Agent 通过 `tool_names` 属性限制可用子集

### 3.3 工具清单

#### 数据工具（`src/agent/tools/data_tools.py`，7 个）

| 工具名 | 功能 | 关键参数 |
|---|---|---|
| `get_realtime_quote` | 实时行情（价格、涨跌幅、量比、换手率、PE/PB、市值） | stock_code |
| `get_daily_history` | 日线 OHLCV + MA 指标 | stock_code, days(默认60, 最大365) |
| `get_chip_distribution` | 筹码分布（获利比例、平均成本、集中度） | stock_code |
| `get_analysis_context` | DB 存储的分析上下文 | stock_code |
| `get_stock_info` | 基本面信息（估值、成长、盈利、机构、板块） | stock_code |
| `get_portfolio_snapshot` | 组合摘要 + 可选风险块 | account_id, include_risk |
| `get_capital_flow` | 主力资金净流入、5d/10d 累计、板块排名 | stock_code |

#### 分析工具（`src/agent/tools/analysis_tools.py`，4 个）

| 工具名 | 功能 | 关键参数 |
|---|---|---|
| `analyze_trend` | 综合趋势分析（均线排列、MACD、RSI、乖离、买卖信号评分0-100） | stock_code, context |
| `calculate_ma` | 任意周期均线 + 乖离率 + 排列汇总 | stock_code, periods |
| `get_volume_analysis` | 量价关系分析（比率、趋势、模式解读） | stock_code |
| `analyze_pattern` | K线/图表形态识别（十字星、锤子线、吞没、双底等） | stock_code, days |

#### 搜索工具（`src/agent/tools/search_tools.py`，2 个）

| 工具名 | 功能 | 关键参数 |
|---|---|---|
| `search_stock_news` | 搜索最新新闻 | stock_code, stock_name, max_results |
| `search_comprehensive_intel` | 多维度情报搜索（新闻、风险、盈利、行业） | stock_code, stock_name, dimensions |

#### 市场工具（`src/agent/tools/market_tools.py`，2 个）

| 工具名 | 功能 | 关键参数 |
|---|---|---|
| `get_market_indices` | 主要指数数据（上证/深证/恒指/标普等） | market(cn/hk/us) |
| `get_sector_rankings` | 板块涨跌排名 | market, top_n, bottom_n |

#### 回测工具（`src/agent/tools/backtest_tools.py`，3 个）

| 工具名 | 功能 | 关键参数 |
|---|---|---|
| `get_skill_backtest_summary` | 技能级回测统计 | skill_id |
| `get_strategy_backtest_summary` | 整体回测摘要 | — |
| `get_stock_backtest_summary` | 单股回测 + 近期评估 | stock_code |

共 18 个注册工具。

---

## 4. 技能系统

### 4.1 技能定义（`src/agent/skills/base.py`）

`Skill` dataclass：
- `name`：技能 ID
- `display_name`：展示名
- `description`：描述
- `instructions`：注入到系统 prompt 的自然语言指令
- `category`：trend/pattern/reversal/framework
- `required_tools`：依赖工具列表
- `market_regimes`：适用市场环境
- `default_active`：是否默认激活
- `default_priority`：默认优先级

### 4.2 技能管理器（`SkillManager`）

- 从 `strategies/` YAML 加载内置技能
- 从用户指定目录加载自定义技能
- 支持 activate/deactivate per-request
- deepcopy 克隆原型保证线程安全

### 4.3 技能路由（`src/agent/skills/router.py`）

`SkillRouter.select_skills(ctx)`：根据上下文（市场环境、可用技能）选择适用技能，最多 3 个

### 4.4 技能聚合（`src/agent/skills/aggregator.py`）

`SkillAggregator`：合并各技能 Agent 意见为加权共识，供 DecisionAgent 参考

---

## 5. LLM 适配器

文件：`src/agent/llm_adapter.py`

`LLMToolAdapter` 通过 LiteLLM `Router` 统一所有 LLM 提供商：

- **多 key 负载均衡**：`simple-shuffle` 策略 + 2 次重试
- **模型 fallback 链**：`get_effective_agent_models_to_try()` 返回主模型 + fallback 模型有序列表
- **硬超时**：`_call_with_hard_timeout()` 在 daemon 线程中强制超时
- **Thinking 模式**：自动为 DeepSeek-R1/QwQ 等推理模型启用 thinking；DeepSeek-Chat 可 opt-in
- **消息转换**：`_convert_messages()` 转 OpenAI 格式，剥离不匹配 provider 的字段
- **响应解析**：`_parse_litellm_response()` 统一为 `LLMResponse`（content, tool_calls, reasoning_content, usage）

关键配置项：
- `agent_litellm_model`：Agent 主模型
- `litellm_fallback_models`：fallback 模型列表
- `llm_model_list`：LiteLLM Router channel YAML 配置
- `agent_llm_timeout_s`：单次 LLM 调用超时（默认 180s）

---

## 6. 暴露的 API 详表

所有 v1 路由挂载在 `/api/v1` 前缀下（`api/v1/router.py`）。

### 6.1 认证 `/api/v1/auth`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/status` | 认证状态 | — | `{enabled, loggedIn, passwordSet, setupState}` |
| POST | `/settings` | 启用/禁用认证、设初始密码 | `{enabled, password}` | `{success}` |
| POST | `/login` | 登录 | `{password}` | `{success, message}` |
| POST | `/change-password` | 修改密码 | `{oldPassword, newPassword}` | `{success}` |
| POST | `/logout` | 注销 | — | `{success}` |

对应代码：`api/v1/endpoints/auth.py`

### 6.2 Agent `/api/v1/agent`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/models` | 列出配置的 Agent 模型部署 | — | 模型列表 |
| GET | `/skills` | 列出可用技能 | — | `SkillListResponse` |
| GET | `/strategies` | 技能别名（legacy） | — | 同 `/skills` |
| POST | `/chat` | 同步聊天 | `{message, session_id?, skills?, stock_code?, stock_name?}` | `ChatResponse{success, content, session_id, error}` |
| POST | `/chat/stream` | SSE 流式聊天 | 同 `/chat` | SSE 事件流 |
| GET | `/chat/sessions` | 列出聊天会话 | `?limit` | 会话列表 |
| GET | `/chat/sessions/{session_id}` | 获取会话消息 | — | 消息列表 |
| DELETE | `/chat/sessions/{session_id}` | 删除会话 | — | `{success}` |
| POST | `/chat/send` | 发送聊天内容到通知渠道 | `{content, channels?}` | `{success}` |
| POST | `/research` | 深度研究 | `{query, stock_code?}` | `ResearchResponse{success, content, sources, token_usage, error}` |

对应代码：`api/v1/endpoints/agent.py`

**SSE 事件格式**（`/chat/stream`）：

| 事件类型 | 数据字段 | 说明 |
|---|---|---|
| `thinking` | `{step}` | Agent 正在思考 |
| `tool_start` | `{step, tool, display_name}` | 开始调用工具 |
| `tool_done` | `{step, tool, display_name, success, duration, result_length}` | 工具调用完成 |
| `generating` | `{content}` | 正在生成文本 |
| `done` | `{content, success, total_steps, session_id}` | 完成 |
| `error` | `{error}` | 错误 |

### 6.3 分析 `/api/v1/analysis`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| POST | `/analyze` | 触发股票分析 | `{stock_code, report_type?, async_mode?, skills?, selection_source?}` | 200 同步结果 / 202 `{task_id}` |
| POST | `/market-review` | 触发大盘复盘 | `{async_mode?}` | 202 `{task_id}` |
| GET | `/tasks` | 列出分析任务 | `?status&limit` | 任务列表 |
| GET | `/tasks/stream` | SSE 任务状态流 | — | SSE 事件流 |
| GET | `/status/{task_id}` | 查询任务状态 | — | `TaskInfo` |

对应代码：`api/v1/endpoints/analysis.py`

### 6.4 历史 `/api/v1/history`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| GET | `/` | 分页历史列表 | `?stock_code&start_date&end_date&limit&offset` | `{items, total}` |
| DELETE | `/by-code/{stock_code}` | 删除某股票全部记录 | — | `{deleted_count}` |
| DELETE | `/` | 批量删除 | `{record_ids}` | `{deleted_count}` |
| GET | `/stocks` | 各股最新一条（stock bar） | — | stock bar 列表 |
| GET | `/{record_id}` | 完整报告详情 | — | `AnalysisResultResponse` |
| GET | `/{record_id}/diagnostics` | 诊断摘要 | — | 诊断数据 |
| GET | `/{record_id}/news` | 关联新闻情报 | — | 新闻数据 |
| GET | `/{record_id}/markdown` | Markdown 格式报告 | — | Markdown 文本 |

对应代码：`api/v1/endpoints/history.py`

### 6.5 股票 `/api/v1/stocks`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| POST | `/extract-from-image` | Vision LLM 从图片提取股票代码 | `{image_base64}` | `{stock_codes}` |
| POST | `/parse-import` | 解析 CSV/Excel/文本导入股票代码 | `{content, format}` | `{stock_codes}` |
| GET | `/watchlist` | 读取关注列表 | — | watchlist |
| POST | `/watchlist/add` | 添加关注 | `{stock_codes}` | `{success}` |
| POST | `/watchlist/remove` | 移除关注 | `{stock_codes}` | `{success}` |
| GET | `/{stock_code}/quote` | 实时行情 | — | quote 数据 |
| GET | `/{stock_code}/history` | 日线历史 | `?days&start_date&end_date` | OHLCV 数据 |

对应代码：`api/v1/endpoints/stocks.py`

### 6.6 回测 `/api/v1/backtest`

| 方法 | 路径 | 功能 | 请求体 | 响应 |
|---|---|---|---|---|
| POST | `/run` | 执行回测 | `{stock_codes, eval_window_days?}` | 回测结果 |
| GET | `/results` | 分页回测结果 | `?limit&offset` | 结果列表 |
| GET | `/performance` | 整体绩效指标 | — | 绩效数据 |
| GET | `/performance/{code}` | 单股绩效指标 | — | 绩效数据 |

对应代码：`api/v1/endpoints/backtest.py`

### 6.7 组合 `/api/v1/portfolio`

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/accounts` | 创建账户 |
| GET | `/accounts` | 列出账户 |
| PUT | `/accounts/{id}` | 更新账户 |
| DELETE | `/accounts/{id}` | 删除账户 |
| POST | `/trades` | 记录交易 |
| GET | `/trades` | 列出交易 |
| DELETE | `/trades/{id}` | 删除交易 |
| POST | `/cash-ledger` | 记录现金事件 |
| GET | `/cash-ledger` | 列出现金事件 |
| DELETE | `/cash-ledger/{id}` | 删除现金事件 |
| POST | `/corporate-actions` | 记录公司行为 |
| GET | `/corporate-actions` | 列出公司行为 |
| DELETE | `/corporate-actions/{id}` | 删除公司行为 |
| GET | `/snapshot` | 组合快照 |
| POST | `/imports/csv/parse` | 解析券商 CSV |
| GET | `/imports/csv/brokers` | 支持券商列表 |
| POST | `/imports/csv/commit` | 解析并提交 CSV（含去重） |
| POST | `/fx/refresh` | 刷新汇率 |
| GET | `/risk` | 组合风险报告 |

对应代码：`api/v1/endpoints/portfolio.py`

### 6.8 告警 `/api/v1/alerts`

| 方法 | 路径 | 功能 |
|---|---|---|
| POST | `/rules` | 创建告警规则 |
| GET | `/rules` | 列出告警规则 |
| GET | `/rules/{id}` | 获取规则详情 |
| PATCH | `/rules/{id}` | 更新规则 |
| DELETE | `/rules/{id}` | 删除规则 |
| POST | `/rules/{id}/enable` | 启用规则 |
| POST | `/rules/{id}/disable` | 禁用规则 |
| POST | `/rules/{id}/test` | 试运行规则 |
| GET | `/triggers` | 触发历史 |
| GET | `/notifications` | 通知尝试记录 |

对应代码：`api/v1/endpoints/alerts.py`

### 6.9 AlphaSift `/api/v1/alphasift`

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/status` | 可用性检查 |
| GET | `/strategies` | 列出策略 |
| POST | `/install` | 安装 AlphaSift（需 admin 会话） |
| POST | `/screen` | 运行股票筛选 |

对应代码：`api/v1/endpoints/alphasift.py`

### 6.10 系统配置 `/api/v1/system`

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/config` | 读取当前配置 |
| GET | `/config/setup/status` | 首次设置状态 |
| PUT | `/config` | 更新配置 |
| GET | `/config/export` | 导出 .env |
| POST | `/config/import` | 导入 .env |
| POST | `/config/validate` | 验证不保存 |
| POST | `/config/llm/test-channel` | 测试 LLM 渠道 |
| POST | `/config/notification/test-channel` | 测试通知渠道 |
| POST | `/config/llm/discover-models` | 发现模型 |
| GET | `/config/schema` | 配置字段元数据 |

对应代码：`api/v1/endpoints/system_config.py`

### 6.11 使用量 `/api/v1/usage`

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/summary` | LLM token 使用摘要（today/month/all） |

### 6.12 健康检查 `/api/v1/health`

| 方法 | 路径 | 功能 |
|---|---|---|
| GET | `/health` | 健康检查 |

另有根级 `GET /api/health` 和 `GET /stocks.index.json`。

---

## 7. 前后端交互链路

### 7.1 传统分析流程（HomePage → stockPoolStore）

```
用户输入股票代码
  → stockPoolStore.submitAnalysis()
    → analysisApi.analyzeAsync()  POST /api/v1/analysis/analyze (async_mode:true)
      → 返回 202 + task_id / 409 DuplicateTaskError
  → useTaskStream (EventSource SSE)
    → /api/v1/analysis/tasks/stream
    → 接收 task_created/started/progress/completed/failed 事件
    → stockPoolStore.syncTaskUpdated()
  → 完成后通过 historyApi.getDetail() 获取完整报告
```

前端关键代码：
- `apps/dsa-web/src/stores/stockPoolStore.ts`（820 行）：中央状态枢纽
- `apps/dsa-web/src/api/analysis.ts`：分析 API 调用
- `apps/dsa-web/src/hooks/useTaskStream.ts`：SSE 事件流监听

### 7.2 Agent 聊天流程（ChatPage → agentChatStore）

```
用户输入消息
  → agentChatStore.startStream()
    → agentApi.chatStream()  POST /api/v1/agent/chat/stream (fetch + ReadableStream)
      → 后端 SSE 流式返回 ProgressStep 事件
    → ReadableStream reader 解析 SSE data 行
    → thinking/tool_start/tool_done → 存入 progressSteps
    → done → 存入最终 assistant message
  → ChatPage 渲染：消息列表 + 思维过程可折叠展示
```

前端关键代码：
- `apps/dsa-web/src/stores/agentChatStore.ts`：聊天状态管理
- `apps/dsa-web/src/api/agent.ts`：Agent API（fetch-based streaming，非 axios）
- `apps/dsa-web/src/pages/ChatPage.tsx`（1294 行）：聊天 UI

### 7.3 历史浏览流程

```
stockPoolStore.loadInitialHistory()
  → historyApi.getList()  GET /api/v1/history
stockPoolStore.selectHistoryItem()
  → historyApi.getDetail()  GET /api/v1/history/{recordId}
```

---

## 8. 数据源层（`data_provider/`）

### 8.1 策略模式 + Failover

`DataFetcherManager`（`data_provider/base.py`）：
- 每个数据源实现 `BaseFetcher` 接口
- 按优先级选择数据源
- 单源失败自动 failover 到下一优先级源
- 每源独立 circuit breaker（连续失败 N 次后熔断一段时间）
- 限速保护

### 8.2 数据源清单

| 文件 | 数据源 | 适用市场 | 优先级 |
|---|---|---|---|
| `tushare_fetcher.py` | Tushare | A 股 | 最高（需 token） |
| `efinance_fetcher.py` | Efinance | A 股 | 高 |
| `akshare_fetcher.py` | AkShare | A 股/港股 | 中 |
| `pytdx_fetcher.py` | PyTDX（通达信） | A 股 | 中 |
| `baostock_fetcher.py` | Baostock | A 股 | 低 |
| `yfinance_fetcher.py` | YFinance | 美股/港股 | 美股主力 |
| `longbridge_fetcher.py` | Longbridge OpenAPI | 美股/港股 | fallback |
| `finnhub_fetcher.py` | Finnhub | 美股 | 补充 |
| `alphavantage_fetcher.py` | AlphaVantage | 美股 | 补充 |
| `tickflow_fetcher.py` | TickFlow | A 股 | 补充 |

### 8.3 基本面适配器

| 文件 | 数据源 | 职责 |
|---|---|---|
| `fundamental_adapter.py` | AkShare | 估值、成长、盈利、机构、资金、龙虎榜、板块 |
| `yfinance_fundamental_adapter.py` | YFinance | 美股/港股基本面 |

---

## 9. 通知系统

`src/notification.py` → `NotificationService`

14 种通知渠道（`src/notification_sender/`）：

| 渠道 | 文件 | 说明 |
|---|---|---|
| Telegram | `telegram_sender.py` | Telegram Bot |
| Discord | `discord_sender.py` | Discord Webhook/Bot |
| 飞书 | `feishu_sender.py` | 飞书 Bot |
| 微信 | `wechat_sender.py` | 企业微信 |
| Email | `email_sender.py` | SMTP 邮件 |
| Slack | `slack_sender.py` | Slack Webhook |
| Pushover | `pushover_sender.py` | Pushover 推送 |
| Ntfy | `ntfy_sender.py` | Ntfy 推送 |
| Gotify | `gotify_sender.py` | Gotify 推送 |
| PushPlus | `pushplus_sender.py` | PushPlus |
| Server酱 | `serverchan3_sender.py` | ServerChan3 |
| AstrBot | `astrbot_sender.py` | AstrBot |
| 自定义 Webhook | `custom_webhook_sender.py` | 通用 Webhook |
| 钉钉 | `dingtalk_sender.py` | 钉钉 Webhook |

单一渠道失败不拖垮主流程。

---

## 10. Bot 层（`bot/`）

### 10.1 命令分发器（`bot/dispatcher.py`）

`CommandDispatcher`：
- 命令注册 + 速率限制 + 分发
- 自然语言路由：regex 预筛 + LLM intent 解析
- `/ask` → 分析意图 → 触发 Agent 分析
- `/chat` → 一般金融问题 → 触发 Agent 聊天

### 10.2 命令清单

| 命令 | 文件 | 功能 |
|---|---|---|
| `/help` | `commands/help_command.py` | 帮助信息 |
| `/status` | `commands/status_command.py` | 系统状态 |
| `/analyze` | `commands/analyze_command.py` | 分析指定股票 |
| `/market` | `commands/market_command.py` | 大盘复盘 |
| `/batch` | `commands/batch_command.py` | 批量分析 |
| `/ask` | `commands/ask_command.py` | Agent 分析 |
| `/chat` | `commands/chat_command.py` | Agent 聊天 |
| `/research` | `commands/research_command.py` | 深度研究 |
| `/strategies` | `commands/strategies_command.py` | 列出/激活技能 |
| `/history` | `commands/history_command.py` | 近期分析 |

### 10.3 平台适配

| 平台 | 文件 | 说明 |
|---|---|---|
| 钉钉 Webhook | `platforms/dingtalk.py` | 钉钉 Webhook |
| 钉钉 Stream | `platforms/dingtalk_stream.py` | 钉钉 Stream 客户端 |
| 飞书 Stream | `platforms/feishu_stream.py` | 飞书 Stream 客户端 |
| Discord | `platforms/discord.py` | Discord Bot |

---

## 11. 持久化层

### 11.1 数据库管理器（`src/storage.py`）

`DatabaseManager`：SQLite 单文件数据库，管理所有持久化表：
- `stock_daily`：日线数据
- `analysis_history`：分析历史
- `news_intel`：新闻情报
- `chat_sessions` / `chat_messages`：聊天会话
- `provider_trace`：LLM 提供商调用追踪
- `fundamental_snapshots`：基本面快照
- `portfolio_accounts` / `portfolio_trades` / `portfolio_cash_ledger` 等：组合管理
- `alert_rules` / `alert_triggers` / `alert_notifications` / `alert_cooldowns`：告警
- `backtest_results` / `backtest_summary`：回测

### 11.2 Repository 层

| 文件 | 表 | 关键方法 |
|---|---|---|
| `analysis_repo.py` | analysis_history | get_by_query_id, get_list, save, count_by_code |
| `stock_repo.py` | stock_daily | get_latest, get_range, save_dataframe, get_analysis_context |
| `alert_repo.py` | alert_rules/triggers/notifications/cooldowns | CRUD + 去重触发 + cooldown 管理 |
| `portfolio_repo.py` | portfolio 系列 | CRUD + 快照 + 写串行化(BEGIN IMMEDIATE) + 去重校验 |
| `backtest_repo.py` | backtest_results/summary | get_candidates, save_results_batch, upsert_summary |

---

## 12. 配置系统（`src/config.py`）

`Config` dataclass 单例（~2962 行），管理所有环境变量：

### 12.1 Agent 相关配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `agent_mode` | False | 是否启用 Agent 模式 |
| `agent_arch` | `single` | Agent 架构：single/multi |
| `agent_orchestrator_mode` | `standard` | 编排模式：quick/standard/full/specialist |
| `agent_orchestrator_timeout_s` | 600 | 编排总超时 |
| `agent_max_steps` | 10 | ReAct 最大步数 |
| `agent_skills` | [] | 激活的技能列表 |
| `agent_litellm_model` | — | Agent 主 LLM 模型 |
| `agent_llm_timeout_s` | 180 | 单次 LLM 调用超时 |
| `agent_tool_timeout_s` | 120 | 工具批次超时 |
| `agent_risk_override` | False | 风险否决买入信号 |
| `agent_deep_research_budget` | 30000 | 深度研究 token 预算 |
| `agent_deep_research_timeout` | 180 | 深度研究超时 |
| `agent_memory_enabled` | False | Agent 记忆/校准 |
| `agent_skill_autoweight` | False | 技能自动加权（基于回测） |

### 12.2 LLM 相关配置

| 配置项 | 说明 |
|---|---|
| `litellm_model` | 全局主模型 |
| `litellm_fallback_models` | fallback 模型列表 |
| `llm_model_list` | LiteLLM Router channel YAML 配置 |

---

## 13. 关键交互流程总结

### 分析全流程（Agent 模式）

```
POST /api/v1/analysis/analyze
  → AnalysisTaskQueue.submit_task()
    → ThreadPoolExecutor._execute_task()
      → AnalysisService.analyze_stock()
        → StockAnalysisPipeline.analyze_stock()
          → 判断 agent_mode → _analyze_with_agent()
            → build_agent_executor() → AgentExecutor 或 AgentOrchestrator
              → ReAct 循环（run_agent_loop）
                → LLM 调用 → tool_calls → 工具执行 → 结果回填 → 循环
              → Dashboard JSON 输出
          → 保存 analysis_history
      → SSE 广播 task_completed
    → 前端 useTaskStream 收到完成事件
  → 前端加载完整报告
```

### Agent 聊天全流程

```
POST /api/v1/agent/chat/stream
  → _build_executor() → AgentExecutor
    → executor.chat(message, session_id, progress_callback)
      → 加载会话历史
      → ReAct 循环 → SSE 事件流式推送
        → thinking → tool_start → tool_done → generating → done
    → 持久化会话消息
  → 前端 ReadableStream reader 解析 SSE 事件
    → 实时渲染思维过程 + 最终回答
```