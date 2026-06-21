# Agent 函数工具全集

> 本工程所有为 Agent 提供数据支撑的函数工具完整目录。
> 分层: **Agent 工具层** → **服务层** → **数据提供层** → **外部 API**

---

## 目录

1. [架构总览](#1-架构总览)
2. [Agent 直接调用的工具（18 个）](#2-agent-直接调用的工具18-个)
   - [数据工具（7 个）](#21-数据工具-data_toolspy)
   - [市场工具（2 个）](#22-市场工具-market_toolspy)
   - [分析工具（4 个）](#23-分析工具-analysis_toolspy)
   - [搜索工具（2 个）](#24-搜索工具-search_toolspy)
   - [回测工具（3 个）](#25-回测工具-backtest_toolspy)
3. [Agent 体系](#3-agent-体系)
4. [数据提供层（10 个数据源）](#4-数据提供层)
5. [服务层](#5-服务层)
6. [数据流架构](#6-数据流架构)

---

## 1. 架构总览

```
Agent (LLM)
  ↓ 工具调用
ToolRegistry.execute(tool_name, **kwargs)
  ↓
工具 Handler (data / market / analysis / search / backtest)
  ↓
Service Layer (HistoryLoader / SearchService / BacktestService / ...)
  ↓
DataFetcherManager (统一入口, 自动路由 + 故障切换)
  ↓
BaseFetcher 实现 (Efinance / Akshare / Yfinance / Longbridge / ...)
  ↓
外部 API (东方财富 / Yahoo Finance / 长桥 OpenAPI / Tavily / ...)
```

---

## 2. Agent 直接调用的工具（18 个）

全部注册在 `src/agent/tools/registry.py` 的 `ToolRegistry` 中，
由 `src/agent/factory.py` 统一加载（`factory.py:183-191`）。

### 2.1 数据工具（`data_tools.py`）— 7 个

| # | 工具名 | 参数 | 返回数据 | 底层链路 |
|---|--------|------|---------|---------|
| 1 | **`get_realtime_quote`** | `stock_code: str`(必填), `market: str`?(auto/cn/hk/us) | 实时行情: price, change_pct, volume, amount, turnover_rate, pe_ratio, pb_ratio, total_mv, circ_mv | `DataFetcherManager.get_realtime_quote` → 多源故障切换 + 字段补齐 |
| 2 | **`get_daily_history`** | `stock_code: str`(必填), `days: int`?(默认60, max365), `market: str`? | OHLCV + MA5/10/20 + volume_ratio | `HistoryLoader.load_history_df` → DB 缓存 → `DataFetcherManager.get_daily_data` |
| 3 | **`get_chip_distribution`** | `stock_code: str`(必填), `market: str`? | 筹码分布: profit_ratio, avg_price, concentration_90, concentration_70 | `DataFetcherManager.get_chip_distribution` (带熔断降级) |
| 4 | **`get_analysis_context`** | `stock_code: str`(必填) | 历史分析上下文（来自数据库） | `DatabaseManager.get_analysis_context` |
| 5 | **`get_stock_info`** | `stock_code: str`(必填) | 基本面聚合: 估值/增长/收益/机构/资金流/龙虎榜/板块 | `DataFetcherManager.get_fundamental_context` (7 个数据块) |
| 6 | **`get_portfolio_snapshot`** | `account_id: str`?, `cost_method: str`?(fifo), `include_risk: bool`? | 投资组合快照 + 可选风险数据 | `PortfolioService` + `PortfolioRiskService` |
| 7 | **`get_capital_flow`** | `stock_code: str`(必填) | 主力资金流向: today_net, 5d_net, 10d_net, 行业排名 | `DataFetcherManager.get_capital_flow_context` |

### 2.2 市场工具（`market_tools.py`）— 2 个

| # | 工具名 | 参数 | 返回数据 | 底层链路 |
|---|--------|------|---------|---------|
| 8 | **`get_market_indices`** | `region: str`?(cn/hk/us, 默认 cn) | 主要指数行情（上证/深证/创业板 etc.） | `DataFetcherManager.get_main_indices` |
| 9 | **`get_sector_rankings`** | `top_n: int`?(默认10) | 行业板块涨跌排名（领涨/领跌） | `DataFetcherManager.get_sector_rankings` |

### 2.3 分析工具（`analysis_tools.py`）— 4 个

| # | 工具名 | 参数 | 返回数据 | 底层链路 |
|---|--------|------|---------|---------|
| 10 | **`analyze_trend`** | `stock_code: str`(必填) | 综合技术趋势: MA 形态/MACD/RSI/量价/支撑阻力/买卖评分 | `StockTrendAnalyzer.analyze` |
| 11 | **`calculate_ma`** | `stock_code: str`(必填), `periods: str`?(5,10,20,30,60,120,250), `days: int`?(120) | 灵活均线 + 价格偏离率 | `HistoryLoader.load_history_df` → 滚动计算 |
| 12 | **`get_volume_analysis`** | `stock_code: str`(必填), `days: int`?(30) | 量价关系: 多日量比/上涨日成交量/放量天数/形态解释 | `HistoryLoader.load_history_df` |
| 13 | **`analyze_pattern`** | `stock_code: str`(必填), `days: int`?(60) | K 线形态: 十字星/锤子线/启明星/黄昏星/吞没/双底/箱体 | `HistoryLoader.load_history_df` |

### 2.4 搜索工具（`search_tools.py`）— 2 个

| # | 工具名 | 参数 | 返回数据 | 底层链路 |
|---|--------|------|---------|---------|
| 14 | **`search_stock_news`** | `stock_code: str`(必填), `stock_name: str`(必填), `max_results: int`?(10) | 股票最新新闻 + 公告 | `SearchService.search_stock_news` |
| 15 | **`search_comprehensive_intel`** | `stock_code: str`(必填), `stock_name: str`(必填) | 多维情报: 最新新闻/市场分析/风险检查/收益展望/行业趋势 | `SearchService.search_comprehensive_intel` |

### 2.5 回测工具（`backtest_tools.py`）— 3 个

| # | 工具名 | 参数 | 返回数据 | 底层链路 |
|---|--------|------|---------|---------|
| 16 | **`get_skill_backtest_summary`** | `skill_id: str`(必填), `eval_window_days: int`?(30) | 按 skill 的回测表现 | `BacktestService.get_skill_summary` |
| 17 | **`get_strategy_backtest_summary`** | `eval_window_days: int`?(30) | 整体回测摘要（旧版别名） | `BacktestService.get_summary(scope="overall")` |
| 18 | **`get_stock_backtest_summary`** | `stock_code: str`(必填), `eval_window_days: int`?(30), `limit: int`?(10) | 指定股票的回测记录 | `BacktestService.get_summary` + `get_recent_evaluations` |

---

## 3. Agent 体系

### 3.1 Agent 分类

| Agent | 文件 | 工具数 | max_steps | 职责 |
|-------|------|-------|-----------|------|
| **BaseAgent** (抽象) | `agents/base_agent.py` | — | — | 共享基类: 工具子集过滤/prompt 组装/ReAct 循环委派 |
| **TechnicalAgent** | `agents/technical_agent.py` | 8 | 6 | 技术/价格/量能分析 |
| **IntelAgent** | `agents/intel_agent.py` | 4 | 4 | 新闻/情报/情绪/催化剂 |
| **RiskAgent** | `agents/risk_agent.py` | 3 | 4 | 风险筛查: 内幕减持/业绩预警/监管/估值极端 |
| **PortfolioAgent** | `agents/portfolio_agent.py` | 2 | 6 | 组合分析: 仓位/相关性/行业集中度 |
| **DecisionAgent** | `agents/decision_agent.py` | **0** | 3 | 纯综合, 无工具 — 聚合之前 Agent 的 opinions 生成决策 |
| **SkillAgent** | `skills/skill_agent.py` | 动态(YAML) | 4 | 执行单一交易策略 |
| **ResearchAgent** | `research.py` | 7 | 子查询预算 | 深度研究: 子问题分解/多轮搜索/交叉验证 |

### 3.2 编排模式

`AgentOrchestrator` 支持 4 种模式（`src/agent/orchestrator.py`）:

| 模式 | 管线 | 适用场景 |
|------|------|---------|
| `quick` | Technical → Decision | 快速行情判断 |
| `standard` | Technical → Intel → Decision | 日常分析 |
| `full` | Technical → Intel → Risk → Decision | 完整风控 |
| `specialist` | Technical → Intel → Risk → SkillAgents → SkillAggregator → Decision | 技能驱动分析 |

### 3.3 Skill 系统（16 个内置策略）

`strategies/` 目录下的 YAML 文件:

`bottom_volume` / `box_oscillation` / `bull_trend` / `chan_theory` / `dragon_head` / `emotion_cycle` / `event_driven` / `expectation_repricing` / `growth_quality` / `hot_theme` / `ma_golden_cross` / `one_yang_three_yin` / `shrink_pullback` / `volume_breakout` / `wave_theory`

**默认激活**: `["dragon_head", "shrink_pullback"]`
**Router 默认兜底**: `["shrink_pullback", "ma_golden_cross", "volume_breakout"]`

### 3.4 核心执行组件

| 组件 | 文件 | 职责 |
|------|------|------|
| `ToolRegistry` | `tools/registry.py` | 工具注册/查找/执行/多提供商 schema 生成 |
| `AgentExecutor` | `executor.py` | 单 Agent ReAct 循环, 支持 task/chat 两种模式 |
| `run_agent_loop` | `runner.py` | **唯一权威的 ReAct 实现**, 所有 Agent 委派至此 |
| `LLMToolAdapter` | `llm_adapter.py` | 多 LLM 提供商工具调用规范化 |
| `AgentMemory` | `memory.py` | 持久化分析记忆/置信度校准/skill 权重 |
| `EventMonitor` | `events.py` | 价格/成交量事件触发告警 |

---

## 4. 数据提供层

### 4.1 策略模式

`DataFetcherManager`（`data_provider/base.py`）按优先级自动路由 + 故障切换 + 熔断。

统一接口的主要方法:

| 方法 | 描述 | 被谁使用 |
|------|------|---------|
| `get_daily_data(code, start, end, days)` | 日线数据, 自动故障切换 | `HistoryLoader`, `StockService` |
| `get_realtime_quote(code)` | 实时行情, 多源切换 + 字段补齐 | `data_tools.get_realtime_quote` |
| `get_chip_distribution(code)` | 筹码分布, 带熔断降级 | `data_tools.get_chip_distribution` |
| `get_fundamental_context(code)` | 聚合 7 个基本面数据块 | `data_tools.get_stock_info` |
| `get_capital_flow_context(code)` | 资金流向块 | `data_tools.get_capital_flow` |
| `get_main_indices(region)` | 主要指数 | `market_tools.get_market_indices` |
| `get_sector_rankings(n)` | 板块涨跌榜 | `market_tools.get_sector_rankings` |
| `prefetch_realtime_quotes(codes)` | 批量预取 | 批量调用优化 |

### 4.2 10 个数据源提供者

| 提供者 | 优先级 | 外部 API | 覆盖市场 | 独特能力 |
|--------|-------|---------|---------|---------|
| **EfinanceFetcher** | 0 | 东方财富(efinance) | A股 | 实时行情/指数/板块/基础信息 |
| **AkshareFetcher** | 1 | 东财/新浪/腾讯(akshare) | A股+港股 | 筹码分布/涨停股池/热门股/概念排名 |
| **TushareFetcher** | 0*(有 token 时提升) | Tushare Pro | A股+港股 | 股票列表/名称 |
| **PytdxFetcher** | 2 | 通达信行情 | A股 | 日线数据 |
| **BaostockFetcher** | 3 | 证券宝 | A股 | 日线数据 |
| **YfinanceFetcher** | 4 | Yahoo Finance | A股+港股+美股 | **全球兜底**, 美股指数 |
| **LongbridgeFetcher** | 5 | 长桥 OpenAPI | **港股+美股** | 高保真实时行情(换手率/PE/市值) |
| **FinnhubFetcher** | 2 | Finnhub.io | **美股** | 美股行情 |
| **AlphaVantageFetcher** | 3 | AlphaVantage | **美股** | 美股日线 |
| **TickFlowFetcher** | 99(专用) | TickFlow API | A股(仅市场回顾) | 指数+市场宽度统计 |

### 4.3 基本面适配器

| 适配器 | 文件 | 适用市场 | 提供数据 |
|--------|------|---------|---------|
| `AkshareFundamentalAdapter` | `fundamental_adapter.py` | A股 | 增长率/收益/机构/资金流/龙虎榜 |
| `YfinanceFundamentalAdapter` | `yfinance_fundamental_adapter.py` | 港股+美股 | 同上, 含货币/行业信息 |

### 4.4 关键类型

| 类型 | 文件 | 说明 |
|------|------|------|
| `UnifiedRealtimeQuote` | `realtime_types.py` | 统一实时行情 dataclass (25+ 字段) |
| `ChipDistribution` | `realtime_types.py` | 筹码分布 dataclass |
| `CircuitBreaker` | `realtime_types.py` | 提供者级别熔断器 |
| US index/stock 工具函数 | `us_index_mapping.py` | 美股指数映射/代码检测 |

---

## 5. 服务层

| 服务 | 文件 | 被哪些工具使用 | 关键方法 |
|------|------|-------------|---------|
| **HistoryLoader** | `history_loader.py` | `get_daily_history`, `calculate_ma`, `get_volume_analysis`, `analyze_pattern` | `load_history_df(code, days)` → DB 缓存 → DataFetcherManager |
| **SearchService** | `search_service.py` | `search_stock_news`, `search_comprehensive_intel` | 7 个搜索提供者(Tavily/SerpAPI/博查/Anspire/MiniMax/Brave/SearXNG), 自动切换 |
| **BacktestService** | `backtest_service.py` | 全部 3 个回测工具 | `get_summary`, `get_skill_summary`, `get_recent_evaluations` |
| **PortfolioService** | `portfolio_service.py` | `get_portfolio_snapshot` | 长桥投资组合快照 |
| **PortfolioRiskService** | `portfolio_risk_service.py` | 风险数据块 | 集中度/回撤/止损评估 |
| **StockTrendAnalyzer** | `stock_analyzer.py` | `analyze_trend` | 综合技术趋势分析 |
| **NameToCodeResolver** | `name_to_code_resolver.py` | — | 股票名称→代码解析 |
| **AlertService** | `alert_service.py` | — | 告警规则 CRUD |
| **AlertIndicators** | `alert_indicators.py` | — | MA/RSI/MACD/KDJ/CCI 指标评估 |
| **SocialSentimentService** | `social_sentiment_service.py` | — | Reddit/X/Polymarket 社交情绪 |
| **ImageStockExtractor** | `image_stock_extractor.py` | — | 图片→股票代码提取(视觉LLM) |
| **AnalysisService** | `analysis_service.py` | — | 完整分析编排入口 |
| **MarketLightService** | `market_light_service.py` | — | 市场快照构建 |
| **ReportRenderer** | `report_renderer.py` | — | Jinja2 报告渲染 |

---

## 6. 数据流架构

### 完整调用链路示例

以 `get_stock_info` 为例，展示完整链路:

```
Agent LLM
  → ToolRegistry.execute("get_stock_info", {"stock_code": "600519"})
    → data_tools._handle_get_stock_info("600519")
      → DataFetcherManager.get_fundamental_context("600519", budget_seconds=30)
        → AkshareFundamentalAdapter.get_fundamental_bundle("600519")     [基本面: 估值/增长/收益/机构]
        → AkshareFundamentalAdapter.get_capital_flow("600519")           [资金流向 + 行业排名]
        → AkshareFundamentalAdapter.get_dragon_tiger_flag("600519")      [龙虎榜]
        → DataFetcherManager.get_belong_boards("600519")                 [所属板块]
        → DataFetcherManager.get_stock_name("600519")                    [股票名称/代码]
      → 聚合所有数据块 → 返回统一 dict
```

### 工具注册入口

`src/agent/factory.py` 约 183-191 行:

```python
from src.agent.tools.data_tools import ALL_DATA_TOOLS
from src.agent.tools.analysis_tools import ALL_ANALYSIS_TOOLS
from src.agent.tools.search_tools import ALL_SEARCH_TOOLS
from src.agent.tools.market_tools import ALL_MARKET_TOOLS
from src.agent.tools.backtest_tools import ALL_BACKTEST_TOOLS

for tool_fn in ALL_DATA_TOOLS + ALL_ANALYSIS_TOOLS + ALL_SEARCH_TOOLS + ALL_MARKET_TOOLS + ALL_BACKTEST_TOOLS:
    registry.register(tool_fn)
```

---

## 附录

### 文件索引

| 层级 | 路径 | 说明 |
|------|------|------|
| 工具注册 | `src/agent/tools/registry.py` | `ToolRegistry`, `ToolDefinition`, `ToolParameter`, `@tool` 装饰器 |
| 数据工具 | `src/agent/tools/data_tools.py` | 7 个数据工具 handler |
| 市场工具 | `src/agent/tools/market_tools.py` | 2 个市场工具 handler |
| 分析工具 | `src/agent/tools/analysis_tools.py` | 4 个分析工具 handler |
| 搜索工具 | `src/agent/tools/search_tools.py` | 2 个搜索工具 handler |
| 回测工具 | `src/agent/tools/backtest_tools.py` | 3 个回测工具 handler |
| 工厂 | `src/agent/factory.py` | 工具注册入口 + Agent 构建 |
| 数据管理器 | `data_provider/base.py` | `DataFetcherManager` + `BaseFetcher` |
| 实时类型 | `data_provider/realtime_types.py` | `UnifiedRealtimeQuote`, `ChipDistribution`, `CircuitBreaker` |
| 基本面适配 | `data_provider/fundamental_adapter.py` | A 股基本面适配器 |
| 基本面适配 | `data_provider/yfinance_fundamental_adapter.py` | 港股/美股基本面适配器 |
| 指数映射 | `data_provider/us_index_mapping.py` | 美股指数符号映射 |
| 搜索服务 | `src/search_service.py` | 7 个搜索提供者 |
| 历史加载 | `src/services/history_loader.py` | 日线数据统一加载入口 |
| 趋势分析 | `src/stock_analyzer.py` | `StockTrendAnalyzer` |
| 编排器 | `src/agent/orchestrator.py` | 多 Agent 管线编排 |
| Agent 基类 | `src/agent/agents/base_agent.py` | Agent 共享基类 |

### 各 Agent 工具集速查

```
TechnicalAgent (8): get_realtime_quote, get_daily_history, analyze_trend, calculate_ma,
                    get_volume_analysis, analyze_pattern, get_chip_distribution, get_analysis_context
IntelAgent (4):     search_stock_news, search_comprehensive_intel, get_stock_info, get_capital_flow
RiskAgent (3):      search_stock_news, get_realtime_quote, get_stock_info
PortfolioAgent (2): get_realtime_quote, get_stock_info
DecisionAgent (0):  (纯综合, 无工具)
ResearchAgent (7):  search_stock_news, search_comprehensive_intel, get_stock_info, get_realtime_quote,
                    get_daily_history, get_sector_rankings, get_market_indices
```
