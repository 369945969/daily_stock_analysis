# 多Agent系统架构设计文档

## 目录
- [概述](#概述)
- [架构分析](#架构分析)
- [核心组件设计](#核心组件设计)
- [通信机制](#通信机制)
- [参数传递规范](#参数传递规范)
- [执行流程](#执行流程)
- [结果汇总机制](#结果汇总机制)
- [错误处理与恢复](#错误处理与恢复)
- [监控与追踪](#监控与追踪)
- [配置管理](#配置管理)
- [实现清单](#实现清单)

---

## 概述

本设计文档基于 `daily_stock_analysis` 项目的多Agent系统架构，提炼出一套通用、健壮、可扩展的多Agent处理系统设计方案。

### 设计目标

1. **模块化**：每个Agent独立封装，职责清晰
2. **可扩展**：支持动态添加新Agent和技能
3. **健壮性**：完善的错误处理和恢复机制
4. **可观测性**：完整的执行追踪和监控
5. **高效性**：支持并行执行和资源优化
6. **灵活性**：配置驱动的流水线编排

---

## 架构分析

### 当前系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    AgentOrchestrator                     │
│  (编排器：管理流水线、超时、降级、结果汇总)                │
└─────────────────────────────────────────────────────────┘
                           │
                           │ 管理 Agent 链
                           ▼
    ┌──────────┬──────────┬──────────┬──────────┐
    │Technical │  Intel   │   Risk   │ Decision │
    │  Agent   │  Agent   │  Agent   │  Agent   │
    └──────────┴──────────┴──────────┴──────────┘
           │         │         │         │
           │         │         │         │
           ▼         ▼         ▼         ▼
    ┌─────────────────────────────────────────┐
    │           AgentContext                   │
    │  (共享上下文：data/opinions/meta)         │
    └─────────────────────────────────────────┘
           │         │         │         │
           │         │         │         │
           ▼         ▼         ▼         ▼
    ┌─────────────────────────────────────────┐
    │          ToolRegistry                    │
    │  (工具注册中心：统一工具调用接口)          │
    └─────────────────────────────────────────┘
           │         │         │         │
           ▼         ▼         ▼         ▼
    ┌─────────────────────────────────────────┐
    │         LLMToolAdapter                   │
    │  (LLM适配器：多provider统一接口)          │
    └─────────────────────────────────────────┘
```

### 核心设计模式

#### 1. **编排器模式 (Orchestrator Pattern)**
- 中央协调器管理整个流水线
- 负责Agent生命周期、超时控制、降级策略
- 统一结果汇总和输出格式化

#### 2. **共享上下文模式 (Shared Context Pattern)**
- AgentContext作为唯一的状态载体
- 所有Agent读写同一上下文对象
- 避免Agent间的直接依赖

#### 3. **意见聚合模式 (Opinion Aggregation Pattern)**
- 每个Agent产生结构化的AgentOpinion
- opinions列表存储所有意见
- DecisionAgent负责汇总和决策

#### 4. **工具注册模式 (Tool Registry Pattern)**
- 统一的工具注册和调用接口
- 支持工具过滤和权限控制
- 工具结果缓存和优化

---

## 核心组件设计

### 1. AgentOrchestrator（编排器）

```python
class AgentOrchestrator:
    """
    多Agent流水线编排器
    
    职责：
    - 构建Agent执行链
    - 管理执行顺序和依赖
    - 处理超时和降级
    - 汇总结果和生成报告
    - 提供进度回调
    """
    
    def __init__(
        self,
        config: OrchestratorConfig,
        tool_registry: ToolRegistry,
        llm_adapter: LLMAdapter,
        skill_manager: SkillManager,
    ):
        self.config = config
        self.tool_registry = tool_registry
        self.llm_adapter = llm_adapter
        self.skill_manager = skill_manager
        self.execution_history = []
        
    def run(self, task: str, context: Dict[str, Any]) -> OrchestratorResult:
        """执行完整的Agent流水线"""
        ctx = self._build_context(task, context)
        return self._execute_pipeline(ctx)
        
    def chat(self, message: str, session_id: str) -> OrchestratorResult:
        """执行对话模式流水线"""
        ctx = self._build_context(message, {})
        ctx.session_id = session_id
        ctx.meta["response_mode"] = "chat"
        return self._execute_pipeline(ctx, parse_dashboard=False)
```

#### OrchestratorConfig 配置项

```python
@dataclass
class OrchestratorConfig:
    # 流水线模式
    mode: str = "standard"  # quick/standard/full/custom
    
    # 超时控制
    timeout_seconds: int = 0  # 0表示不限制
    min_stage_budget_seconds: int = 15  # 最小阶段预算
    
    # 执行控制
    max_steps: int = 10
    max_retries: int = 3
    enable_parallel: bool = False  # 是否启用并行执行
    
    # 降级策略
    enable_degradation: bool = True  # 启用降级
    degradation_modes: List[str] = ["skip_non_critical", "use_cached_data"]
    
    # 监控
    enable_progress_callback: bool = True
    enable_execution_trace: bool = True
    
    # Agent配置
    agent_configs: Dict[str, AgentConfig] = field(default_factory=dict)
```

### 2. BaseAgent（Agent基类）

```python
class BaseAgent(ABC):
    """
    所有Agent的抽象基类
    
    必须实现：
    - agent_name: Agent唯一标识
    - system_prompt(): 系统提示词
    - build_user_message(): 用户消息构建
    
    可选实现：
    - tool_names: 可用工具列表
    - max_steps: 最大执行步骤
    - post_process(): 结果后处理
    - validate_context(): 上下文验证
    - prepare_tools(): 工具准备
    """
    
    agent_name: str = "base"
    tool_names: Optional[List[str]] = None
    max_steps: int = 6
    
    def __init__(
        self,
        tool_registry: ToolRegistry,
        llm_adapter: LLMAdapter,
        config: AgentConfig,
    ):
        self.tool_registry = tool_registry
        self.llm_adapter = llm_adapter
        self.config = config
        self.memory = AgentMemory.from_config()
        
    @abstractmethod
    def system_prompt(self, ctx: AgentContext) -> str:
        """构建系统提示词"""
        
    @abstractmethod
    def build_user_message(self, ctx: AgentContext) -> str:
        """构建用户消息"""
        
    def run(
        self,
        ctx: AgentContext,
        progress_callback: Optional[Callable] = None,
        timeout_seconds: Optional[float] = None,
    ) -> StageResult:
        """执行Agent并返回结果"""
        t0 = time.time()
        result = StageResult(stage_name=self.agent_name)
        
        try:
            # 1. 验证上下文
            self.validate_context(ctx)
            
            # 2. 准备工具
            registry = self.prepare_tools()
            
            # 3. 构建消息
            messages = self._build_messages(ctx)
            
            # 4. 执行LLM循环
            loop_result = run_agent_loop(
                messages=messages,
                tool_registry=registry,
                llm_adapter=self.llm_adapter,
                max_steps=self.max_steps,
                timeout_seconds=timeout_seconds,
                progress_callback=progress_callback,
            )
            
            # 5. 后处理
            opinion = self.post_process(ctx, loop_result.content)
            if opinion:
                ctx.add_opinion(opinion)
                result.opinion = opinion
                
            result.status = StageStatus.COMPLETED
            
        except Exception as exc:
            result.status = StageStatus.FAILED
            result.error = str(exc)
            
        finally:
            result.duration_s = time.time() - t0
            
        return result
```

#### AgentConfig 配置项

```python
@dataclass
class AgentConfig:
    # 执行控制
    max_steps: int = 6
    timeout_seconds: int = 300
    
    # 工具权限
    allowed_tools: List[str] = field(default_factory=list)
    denied_tools: List[str] = field(default_factory=list)
    
    # 记忆系统
    enable_memory: bool = True
    memory_calibration: bool = True
    
    # 输出控制
    enable_opinion: bool = True  # 是否产生AgentOpinion
    output_format: str = "json"  # json/text/markdown
    
    # 依赖关系
    dependencies: List[str] = field(default_factory=list)  # 依赖的Agent
    required_data: List[str] = field(default_factory=list)  # 需要的数据
    
    # 优先级
    priority: int = 100  # 执行优先级
    critical: bool = False  # 是否关键Agent（失败则终止）
```

### 3. AgentContext（共享上下文）

```python
@dataclass
class AgentContext:
    """
    Agent间共享的上下文对象
    
    包含：
    - 任务信息（query, stock_code等）
    - 共享数据（data字典）
    - Agent意见（opinions列表）
    - 风险标记（risk_flags）
    - 元数据（meta字典）
    """
    
    # 任务标识
    query: str = ""
    task_id: str = ""
    stock_code: str = ""
    stock_name: str = ""
    session_id: str = ""
    
    # 共享数据
    data: Dict[str, Any] = field(default_factory=dict)
    # 典型键: realtime_quote, daily_history, trend_result, 
    #        chip_distribution, news_context
    
    # Agent意见列表
    opinions: List[AgentOpinion] = field(default_factory=list)
    
    # 风险标记
    risk_flags: List[Dict[str, Any]] = field(default_factory=list)
    
    # 元数据
    meta: Dict[str, Any] = field(default_factory=dict)
    # 典型键: skills_requested, report_language, 
    #        response_mode, conversation_history
    
    # 执行追踪
    execution_trace: List[Dict[str, Any]] = field(default_factory=list)
    
    # 时间戳
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    
    # 辅助方法
    def add_opinion(self, opinion: AgentOpinion) -> None:
        """添加Agent意见"""
        
    def get_data(self, key: str, default: Any = None) -> Any:
        """获取共享数据"""
        
    def set_data(self, key: str, value: Any) -> None:
        """设置共享数据"""
        
    def add_risk_flag(self, category: str, description: str, severity: str) -> None:
        """添加风险标记"""
        
    def update_execution_trace(self, stage: str, action: str, details: Dict) -> None:
        """更新执行追踪"""
```

### 4. AgentOpinion（Agent意见）

```python
@dataclass
class AgentOpinion:
    """
    Agent的结构化输出意见
    
    每个Agent产生一个AgentOpinion对象，
    包含分析信号、置信度、推理过程等
    """
    
    # 基本信息
    agent_name: str = ""
    timestamp: float = 0.0
    
    # 分析结果
    signal: str = ""  # buy/hold/sell/strong_buy/strong_sell
    confidence: float = 0.0  # 0.0-1.0
    reasoning: str = ""  # 分析推理过程
    
    # 关键数据
    key_levels: Dict[str, float] = field(default_factory=dict)
    # 典型键: support, resistance, stop_loss, take_profit
    
    # 原始数据
    raw_data: Dict[str, Any] = field(default_factory=dict)
    # Agent自定义的额外数据
    
    # 验证信息
    validated: bool = False
    validation_errors: List[str] = field(default_factory=list)
    
    # 校准信息
    calibrated_confidence: Optional[float] = None
    calibration_factor: Optional[float] = None
```

### 5. StageResult（阶段结果）

```python
@dataclass
class StageResult:
    """
    单个Agent执行的结果
    
    用于编排器判断是否继续、重试或终止
    """
    
    # 基本信息
    stage_name: str = ""
    status: StageStatus = StageStatus.PENDING
    # PENDING/RUNNING/COMPLETED/FAILED/SKIPPED
    
    # 执行结果
    opinion: Optional[AgentOpinion] = None
    error: Optional[str] = None
    
    # 性能指标
    duration_s: float = 0.0
    tokens_used: int = 0
    tool_calls_count: int = 0
    
    # 详细信息
    meta: Dict[str, Any] = field(default_factory=dict)
    # 典型键: raw_text, tool_calls_log, models_used
    
    @property
    def success(self) -> bool:
        """是否成功完成"""
        return self.status == StageStatus.COMPLETED
```

---

## 通信机制

### 1. Agent间通信流程

```
┌─────────────────────────────────────────────────────────┐
│  Orchestrator                                            │
│                                                          │
│  1. 创建 AgentContext                                    │
│  2. 调用 Agent1.run(ctx)                                 │
│     ├─ Agent1读取ctx.data                                │
│     ├─ Agent1调用工具获取数据                             │
│     ├─ Agent1写入ctx.data                                │
│     ├─ Agent1生成AgentOpinion                            │
│     └─ Agent1添加到ctx.opinions                          │
│                                                          │
│  3. 调用 Agent2.run(ctx)                                 │
│     ├─ Agent2读取ctx.data (包含Agent1的数据)              │
│     ├─ Agent2读取ctx.opinions (包含Agent1的意见)          │
│     ├─ Agent2生成AgentOpinion                            │
│     └─ Agent2添加到ctx.opinions                          │
│                                                          │
│  4. 调用 DecisionAgent.run(ctx)                          │
│     ├─ DecisionAgent读取所有opinions                      │
│     ├─ DecisionAgent汇总决策                              │
│     └ DecisionAgent生成最终结果                           │
│                                                          │
│  5. 从ctx提取最终结果                                     │
└─────────────────────────────────────────────────────────┘
```

### 2. 数据传递方式

#### 通过AgentContext传递

```python
# Agent1 设置数据
ctx.set_data("realtime_quote", quote_data)
ctx.set_data("trend_result", trend_data)

# Agent2 读取数据
quote = ctx.get_data("realtime_quote")
trend = ctx.get_data("trend_result")

# Agent1 添加意见
ctx.add_opinion(AgentOpinion(
    agent_name="technical",
    signal="buy",
    confidence=0.8,
    reasoning="均线多头排列，趋势向上"
))

# Agent2 读取意见
technical_opinion = ctx.opinions[-1]
```

#### 通过meta传递元数据

```python
# Orchestrator 设置元数据
ctx.meta["skills_requested"] = ["bull_trend", "shrink_pullback"]
ctx.meta["report_language"] = "zh"
ctx.meta["response_mode"] = "dashboard"

# Agent 读取元数据
skills = ctx.meta.get("skills_requested", [])
language = ctx.meta.get("report_language", "zh")
```

### 3. 消息传递格式

#### 系统消息（System Message）

```python
{
    "role": "system",
    "content": """
    你是技术分析Agent，负责分析股票的技术指标和趋势。
    
    ## 可用工具
    - get_realtime_quote: 获取实时行情
    - analyze_trend: 分析技术指标
    - get_chip_distribution: 获取筹码分布
    
    ## 输出要求
    必须生成AgentOpinion格式的分析结果
    """
}
```

#### 用户消息（User Message）

```python
{
    "role": "user",
    "content": """
    分析股票 600519 (贵州茅台)
    
    [预取数据]
    realtime_quote: {...}
    daily_history: {...}
    
    请基于以上数据进行技术分析
    """
}
```

#### 工具调用消息（Tool Call）

```python
{
    "role": "assistant",
    "content": None,
    "tool_calls": [
        {
            "id": "call_123",
            "type": "function",
            "function": {
                "name": "analyze_trend",
                "arguments": '{"stock_code": "600519"}'
            }
        }
    ]
}
```

#### 工具结果消息（Tool Result）

```python
{
    "role": "tool",
    "tool_call_id": "call_123",
    "content": '{"trend_score": 85, "ma_alignment": "bullish"}'
}
```

---

## 参数传递规范

### 1. 任务输入参数

```python
{
    # 必需参数
    "task": "分析股票600519的投资机会",
    "stock_code": "600519",
    "stock_name": "贵州茅台",
    
    # 可选参数
    "skills": ["bull_trend", "shrink_pullback"],
    "report_language": "zh",
    "mode": "standard",
    
    # 预取数据（可选，避免重复调用）
    "realtime_quote": {...},
    "daily_history": {...},
    "trend_result": {...},
    
    # 元数据
    "user_platform": "web",
    "session_id": "session_123",
}
```

### 2. Agent间传递的数据

#### 必需传递的数据

```python
ctx.data = {
    # 基础行情数据
    "realtime_quote": {
        "price": 1800.0,
        "volume_ratio": 1.5,
        "turnover_rate": 0.8,
    },
    
    # 历史K线数据
    "daily_history": [
        {"date": "2024-01-01", "close": 1750, "volume": 1000},
        ...
    ],
    
    # 技术指标结果
    "trend_result": {
        "ma5": 1780,
        "ma10": 1760,
        "ma20": 1750,
        "trend_score": 85,
        "ma_alignment": "bullish",
    },
    
    # 筹码分布
    "chip_distribution": {
        "profit_ratio": 0.75,
        "avg_cost": 1700,
        "concentration": 0.6,
    },
    
    # 新闻资讯
    "news_context": {
        "latest_news": "公司发布业绩预告",
        "risk_alerts": ["股东减持计划"],
        "positive_catalysts": ["新产品发布"],
    },
}
```

#### AgentOpinion传递

```python
ctx.opinions = [
    AgentOpinion(
        agent_name="technical",
        signal="buy",
        confidence=0.85,
        reasoning="均线多头排列，MACD金叉，趋势向上",
        key_levels={
            "support": 1750,
            "resistance": 1850,
            "stop_loss": 1720,
        },
        raw_data={
            "trend_score": 85,
            "ma_alignment": "bullish",
        },
    ),
    AgentOpinion(
        agent_name="intel",
        signal="hold",
        confidence=0.6,
        reasoning="存在股东减持风险，建议观望",
        raw_data={
            "risk_alerts": ["股东减持"],
        },
    ),
]
```

### 3. 元数据传递

```python
ctx.meta = {
    # 技能配置
    "skills_requested": ["bull_trend"],
    "skills_activated": ["bull_trend"],
    
    # 输出配置
    "report_language": "zh",
    "response_mode": "dashboard",
    
    # 对话历史
    "conversation_history": [
        {"role": "user", "content": "分析茅台"},
        {"role": "assistant", "content": "..."},
    ],
    
    # 市场环境
    "market_phase_context": {
        "phase": "intraday",
        "market_sentiment": "neutral",
    },
    
    # 执行追踪
    "execution_trace": [
        {"stage": "technical", "action": "start", "timestamp": 123456},
        {"stage": "technical", "action": "complete", "timestamp": 123789},
    ],
}
```

---

## 执行流程

### 1. 标准执行流程

```
┌─────────────────────────────────────────────────────────┐
│  Step 1: 初始化                                          │
│  ├─ 解析任务参数                                         │
│  ├─ 创建AgentContext                                     │
│  ├─ 加载配置和技能                                       │
│  └─ 初始化ToolRegistry                                   │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Step 2: 构建Agent链                                     │
│  ├─ 根据mode选择Agent组合                                │
│  ├─ quick: [Technical, Decision]                         │
│  ├─ standard: [Technical, Intel, Decision]               │
│  ├─ full: [Technical, Intel, Risk, Decision]             │
│  └─ custom: 根据配置动态构建                              │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Step 3: 执行Agent流水线                                 │
│                                                          │
│  for agent in agent_chain:                               │
│      ├─ 检查超时和预算                                   │
│      ├─ 调用 agent.run(ctx)                              │
│      ├─ 记录StageResult                                  │
│      ├─ 处理失败（降级或终止）                            │
│      └─ 更新执行追踪                                     │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Step 4: 汇总结果                                        │
│  ├─ 收集所有AgentOpinion                                 │
│  ├─ DecisionAgent生成最终决策                            │
│  ├─ 应用风险覆盖规则                                     │
│  └─ 格式化输出（dashboard/chat）                         │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Step 5: 生成报告                                        │
│  ├─ 构建OrchestratorResult                               │
│  ├─ 计算统计数据                                         │
│  ├─ 生成执行报告                                         │
│  └─ 持久化结果                                           │
└─────────────────────────────────────────────────────────┘
```

### 2. 并行执行流程（可选）

```python
# 并行执行独立的Agent
parallel_agents = ["technical", "intel", "fundamental"]

with ThreadPoolExecutor(max_workers=3) as executor:
    futures = {
        executor.submit(agent.run, ctx): agent.agent_name
        for agent in parallel_agents
    }
    
    for future in as_completed(futures):
        agent_name = futures[future]
        result = future.result()
        ctx.add_opinion(result.opinion)
```

### 3. 降级执行流程

```
┌─────────────────────────────────────────────────────────┐
│  正常执行流程                                            │
│  Technical → Intel → Risk → Decision                     │
└─────────────────────────────────────────────────────────┘
                           │
                           │ Risk Agent失败
                           ▼
┌─────────────────────────────────────────────────────────┐
│  降级流程                                                │
│  Technical → Intel → [Risk跳过] → Decision               │
│                                                          │
│  DecisionAgent使用Technical+Intel的意见                  │
│  标记结果为"降级生成"                                     │
└─────────────────────────────────────────────────────────┘
```

---

## 结果汇总机制

### 1. Opinion聚合

```python
class OpinionAggregator:
    """意见聚合器"""
    
    def aggregate(self, ctx: AgentContext) -> AgentOpinion:
        """聚合所有Agent意见"""
        opinions = ctx.opinions
        
        # 1. 信号投票
        signals = [op.signal for op in opinions]
        final_signal = self._vote_signal(signals)
        
        # 2. 置信度加权平均
        weights = self._get_agent_weights(ctx)
        final_confidence = sum(
            op.confidence * weights[op.agent_name]
            for op in opinions
        ) / sum(weights.values())
        
        # 3. 关键价位合并
        key_levels = {}
        for op in opinions:
            key_levels.update(op.key_levels)
            
        # 4. 推理过程整合
        reasoning = self._merge_reasoning(opinions)
        
        return AgentOpinion(
            agent_name="aggregated",
            signal=final_signal,
            confidence=final_confidence,
            reasoning=reasoning,
            key_levels=key_levels,
        )
```

### 2. Dashboard生成

```python
class DashboardBuilder:
    """仪表盘构建器"""
    
    def build(self, ctx: AgentContext) -> Dict[str, Any]:
        """构建完整的决策仪表盘"""
        
        # 1. 核心结论
        core_conclusion = self._build_core_conclusion(ctx)
        
        # 2. 数据透视
        data_perspective = self._build_data_perspective(ctx)
        
        # 3. 情报汇总
        intelligence = self._build_intelligence(ctx)
        
        # 4. 作战计划
        battle_plan = self._build_battle_plan(ctx)
        
        return {
            "stock_name": ctx.stock_name,
            "sentiment_score": self._calculate_sentiment(ctx),
            "decision_type": self._get_final_signal(ctx),
            "confidence_level": self._get_confidence_label(ctx),
            "dashboard": {
                "core_conclusion": core_conclusion,
                "data_perspective": data_perspective,
                "intelligence": intelligence,
                "battle_plan": battle_plan,
            },
            "analysis_summary": self._build_summary(ctx),
            "key_points": self._extract_key_points(ctx),
            "risk_warning": self._build_risk_warning(ctx),
        }
```

### 3. 统计数据生成

```python
@dataclass
class ExecutionStats:
    """执行统计数据"""
    
    total_stages: int = 0
    completed_stages: int = 0
    failed_stages: int = 0
    skipped_stages: int = 0
    
    total_tokens: int = 0
    total_tool_calls: int = 0
    total_duration_s: float = 0.0
    
    models_used: List[str] = field(default_factory=list)
    stage_results: List[StageResult] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_stages": self.total_stages,
            "completed_stages": self.completed_stages,
            "failed_stages": self.failed_stages,
            "skipped_stages": self.skipped_stages,
            "total_tokens": self.total_tokens,
            "total_tool_calls": self.total_tool_calls,
            "total_duration_s": round(self.total_duration_s, 2),
            "models_used": self.models_used,
            "success_rate": self.completed_stages / self.total_stages,
        }
```

---

## 错误处理与恢复

### 1. 错误分类

```python
class ErrorType(Enum):
    """错误类型"""
    
    # 执行错误
    TOOL_EXECUTION_ERROR = "tool_execution"  # 工具执行失败
    LLM_ERROR = "llm_error"  # LLM调用失败
    TIMEOUT_ERROR = "timeout"  # 超时错误
    
    # 配置错误
    CONFIG_ERROR = "config"  # 配置错误
    VALIDATION_ERROR = "validation"  # 验证错误
    
    # 依赖错误
    DEPENDENCY_ERROR = "dependency"  # 依赖缺失
    DATA_ERROR = "data"  # 数据错误
    
    # 系统错误
    SYSTEM_ERROR = "system"  # 系统级错误
    NETWORK_ERROR = "network"  # 网络错误
```

### 2. 错误恢复策略

```python
class RecoveryStrategy:
    """错误恢复策略"""
    
    def handle_error(
        self,
        error: Exception,
        ctx: AgentContext,
        result: StageResult,
    ) -> RecoveryAction:
        """根据错误类型决定恢复动作"""
        
        error_type = self._classify_error(error)
        
        if error_type == ErrorType.TOOL_EXECUTION_ERROR:
            # 工具执行失败：使用缓存数据或跳过
            return RecoveryAction(
                action="use_cached_or_skip",
                message="工具执行失败，使用缓存数据继续",
            )
            
        elif error_type == ErrorType.LLM_ERROR:
            # LLM错误：重试或降级
            return RecoveryAction(
                action="retry_with_fallback_model",
                max_retries=3,
            )
            
        elif error_type == ErrorType.TIMEOUT_ERROR:
            # 超时：终止或降级
            if result.stage_name in ["decision"]:
                return RecoveryAction(
                    action="abort",
                    message="关键Agent超时，终止执行",
                )
            else:
                return RecoveryAction(
                    action="skip_and_continue",
                    message="非关键Agent超时，跳过继续",
                )
                
        elif error_type == ErrorType.DEPENDENCY_ERROR:
            # 依赖错误：等待或终止
            return RecoveryAction(
                action="wait_or_abort",
                timeout=30,
            )
```

### 3. 降级策略

```python
class DegradationStrategy:
    """降级策略"""
    
    def should_degrade(
        self,
        failed_agent: str,
        ctx: AgentContext,
    ) -> bool:
        """判断是否应该降级"""
        
        # 关键Agent不降级
        critical_agents = ["decision"]
        if failed_agent in critical_agents:
            return False
            
        # 已有足够数据可降级
        min_required_opinions = 2
        if len(ctx.opinions) >= min_required_opinions:
            return True
            
        return False
        
    def apply_degradation(
        self,
        ctx: AgentContext,
        failed_stage: str,
    ) -> None:
        """应用降级策略"""
        
        # 标记降级状态
        ctx.meta["degraded"] = True
        ctx.meta["degraded_stages"] = ctx.meta.get("degraded_stages", [])
        ctx.meta["degraded_stages"].append(failed_stage)
        
        # 添加降级提示
        ctx.add_risk_flag(
            category="degradation",
            description=f"{failed_stage}阶段失败，结果为降级生成",
            severity="medium",
        )
```

---

## 监控与追踪

### 1. 执行追踪

```python
class ExecutionTracer:
    """执行追踪器"""
    
    def trace_stage_start(
        self,
        ctx: AgentContext,
        stage: str,
        agent: BaseAgent,
    ) -> None:
        """记录阶段开始"""
        ctx.update_execution_trace(
            stage=stage,
            action="start",
            details={
                "agent_name": agent.agent_name,
                "max_steps": agent.max_steps,
                "timestamp": time.time(),
            }
        )
        
    def trace_tool_call(
        self,
        ctx: AgentContext,
        stage: str,
        tool_name: str,
        arguments: Dict,
    ) -> None:
        """记录工具调用"""
        ctx.update_execution_trace(
            stage=stage,
            action="tool_call",
            details={
                "tool_name": tool_name,
                "arguments": arguments,
                "timestamp": time.time(),
            }
        )
        
    def trace_stage_complete(
        self,
        ctx: AgentContext,
        stage: str,
        result: StageResult,
    ) -> None:
        """记录阶段完成"""
        ctx.update_execution_trace(
            stage=stage,
            action="complete",
            details={
                "status": result.status.value,
                "duration_s": result.duration_s,
                "tokens_used": result.tokens_used,
                "timestamp": time.time(),
            }
        )
```

### 2. 进度回调

```python
def progress_callback(event: Dict[str, Any]) -> None:
    """进度事件回调"""
    
    event_type = event.get("type")
    
    if event_type == "stage_start":
        logger.info(f"[{event['stage']}] 开始执行")
        
    elif event_type == "tool_call":
        logger.info(f"[{event['stage']}] 调用工具: {event['tool']}")
        
    elif event_type == "stage_done":
        logger.info(
            f"[{event['stage']}] 完成 "
            f"(耗时: {event['duration']}s, "
            f"状态: {event['status']})"
        )
        
    elif event_type == "pipeline_timeout":
        logger.error(
            f"[Pipeline] 超时 "
            f"(阶段: {event['stage']}, "
            f"耗时: {event['elapsed']}s)"
        )
```

### 3. 性能监控

```python
class PerformanceMonitor:
    """性能监控器"""
    
    def __init__(self):
        self.metrics = {
            "total_runs": 0,
            "successful_runs": 0,
            "failed_runs": 0,
            "total_tokens": 0,
            "total_duration": 0,
            "agent_stats": {},
        }
        
    def record_run(self, result: OrchestratorResult) -> None:
        """记录执行结果"""
        self.metrics["total_runs"] += 1
        
        if result.success:
            self.metrics["successful_runs"] += 1
        else:
            self.metrics["failed_runs"] += 1
            
        self.metrics["total_tokens"] += result.total_tokens
        self.metrics["total_duration"] += result.stats.total_duration_s
        
        # Agent级别统计
        for stage_result in result.stats.stage_results:
            agent_name = stage_result.stage_name
            if agent_name not in self.metrics["agent_stats"]:
                self.metrics["agent_stats"][agent_name] = {
                    "runs": 0,
                    "successes": 0,
                    "failures": 0,
                    "avg_duration": 0,
                }
            
            stats = self.metrics["agent_stats"][agent_name]
            stats["runs"] += 1
            if stage_result.success:
                stats["successes"] += 1
            else:
                stats["failures"] += 1
```

---

## 配置管理

### 1. 配置文件结构

```yaml
# orchestrator_config.yaml

orchestrator:
  mode: standard
  timeout_seconds: 600
  min_stage_budget_seconds: 15
  
  execution:
    max_steps: 10
    max_retries: 3
    enable_parallel: false
    
  degradation:
    enabled: true
    modes:
      - skip_non_critical
      - use_cached_data
      
  monitoring:
    enable_progress_callback: true
    enable_execution_trace: true
    enable_performance_monitor: true

agents:
  technical:
    max_steps: 6
    timeout_seconds: 300
    tools:
      allowed:
        - get_realtime_quote
        - analyze_trend
        - get_chip_distribution
      denied: []
    memory:
      enabled: true
      calibration: true
    output:
      format: json
      enable_opinion: true
    dependencies: []
    required_data: []
    priority: 100
    critical: false
    
  intel:
    max_steps: 4
    timeout_seconds: 200
    tools:
      allowed:
        - search_stock_news
        - search_comprehensive_intel
    dependencies:
      - technical
    required_data:
      - realtime_quote
    priority: 80
    critical: false
    
  risk:
    max_steps: 3
    timeout_seconds: 150
    tools:
      allowed:
        - search_stock_news
    dependencies:
      - intel
    priority: 60
    critical: false
    
  decision:
    max_steps: 5
    timeout_seconds: 300
    tools: []
    dependencies:
      - technical
      - intel
      - risk
    required_data:
      - realtime_quote
      - trend_result
    required_opinions:
      - technical
      - intel
    priority: 50
    critical: true

skills:
  builtin_dir: strategies/
  custom_dir: custom_skills/
  default_active:
    - bull_trend
    - shrink_pullback
  activation_policy: explicit

tools:
  registry:
    cache_enabled: true
    cache_ttl: 300
  execution:
    timeout: 30
    retry_count: 2
```

### 2. 配置加载

```python
class ConfigManager:
    """配置管理器"""
    
    def load_config(self, config_path: str) -> OrchestratorConfig:
        """加载配置文件"""
        with open(config_path) as f:
            config_dict = yaml.safe_load(f)
            
        return OrchestratorConfig(
            mode=config_dict["orchestrator"]["mode"],
            timeout_seconds=config_dict["orchestrator"]["timeout_seconds"],
            agent_configs=self._parse_agent_configs(config_dict["agents"]),
        )
        
    def _parse_agent_configs(
        self,
        agents_dict: Dict,
    ) -> Dict[str, AgentConfig]:
        """解析Agent配置"""
        configs = {}
        for agent_name, agent_config in agents_dict.items():
            configs[agent_name] = AgentConfig(
                max_steps=agent_config["max_steps"],
                timeout_seconds=agent_config["timeout_seconds"],
                allowed_tools=agent_config["tools"]["allowed"],
                dependencies=agent_config["dependencies"],
                critical=agent_config["critical"],
            )
        return configs
```

---

## 实现清单

### 核心组件实现清单

#### 1. 基础组件（必须实现）

- [ ] **AgentContext** - 共享上下文类
  - [ ] data字典管理
  - [ ] opinions列表管理
  - [ ] risk_flags管理
  - [ ] meta字典管理
  - [ ] execution_trace追踪
  - [ ] 辅助方法实现

- [ ] **AgentOpinion** - Agent意见类
  - [ ] 基本字段定义
  - [ ] 置信度校准
  - [ ] 验证机制

- [ ] **StageResult** - 阶段结果类
  - [ ] 状态枚举定义
  - [ ] 性能指标记录
  - [ ] 元数据管理

- [ ] **BaseAgent** - Agent基类
  - [ ] 抽象方法定义
  - [ ] run()执行流程
  - [ ] 工具过滤机制
  - [ ] 记忆系统集成
  - [ ] 后处理钩子

- [ ] **AgentOrchestrator** - 编排器
  - [ ] Agent链构建
  - [ ] 流水线执行
  - [ ] 超时控制
  - [ ] 降级策略
  - [ ] 结果汇总
  - [ ] 进度回调

#### 2. 工具系统（必须实现）

- [ ] **ToolRegistry** - 工具注册中心
  - [ ] 工具注册接口
  - [ ] 工具过滤
  - [ ] 工具执行
  - [ ] Schema生成
  - [ ] 结果缓存

- [ ] **ToolDefinition** - 工具定义
  - [ ] 参数Schema
  - [ ] 多Provider适配
  - [ ] 执行Handler

- [ ] **ToolParameter** - 参数定义
  - [ ] 类型定义
  - [ ] 验证规则
  - [ ] 默认值

#### 3. LLM适配（必须实现）

- [ ] **LLMAdapter** - LLM适配器
  - [ ] 多Provider支持
  - [ ] 统一调用接口
  - [ ] 工具调用封装
  - [ ] 错误处理
  - [ ] Token统计

- [ ] **LLMToolAdapter** - 工具LLM适配器
  - [ ] 工具声明生成
  - [ ] 工具调用解析
  - [ ] 工具结果注入

#### 4. 执行引擎（必须实现）

- [ ] **AgentRunner** - 执行引擎
  - [ ] ReAct循环
  - [ ] 工具执行
  - [ ] 消息管理
  - [ ] 超时控制
  - [ ] 并行执行

#### 5. 配置系统（必须实现）

- [ ] **OrchestratorConfig** - 编排器配置
- [ ] **AgentConfig** - Agent配置
- [ ] **ConfigManager** - 配置管理器
- [ ] YAML配置加载

#### 6. 监控系统（推荐实现）

- [ ] **ExecutionTracer** - 执行追踪器
- [ ] **PerformanceMonitor** - 性能监控
- [ ] **ProgressCallback** - 进度回调

#### 7. 错误处理（推荐实现）

- [ ] **ErrorHandler** - 错误处理器
- [ ] **RecoveryStrategy** - 恢复策略
- [ ] **DegradationStrategy** - 降级策略

#### 8. 记忆系统（可选实现）

- [ ] **AgentMemory** - Agent记忆
  - [ ] 历史分析记录
  - [ ] 校准数据
  - [ ] 性能追踪

#### 9. 技能系统（可选实现）

- [ ] **SkillManager** - 技能管理器
  - [ ] 技能加载
  - [ ] 技能激活
  - [ ] 指令生成

- [ ] **SkillRouter** - 技能路由
  - [ ] 技能选择
  - [ ] 条件匹配

- [ ] **SkillAgent** - 技能Agent
  - [ ] 技能执行
  - [ ] 意见生成

### Agent实现清单

#### 必须实现的Agent

- [ ] **TechnicalAgent** - 技术分析Agent
  - [ ] 技术指标分析
  - [ ] 趋势判断
  - [ ] 关键价位识别
  - [ ] **职责定义**：
    - 获取实时行情和历史K线数据
    - 运行技术指标（趋势、均线、量能、形态）
    - 生成结构化的趋势/动量/支撑阻力意见
  - [ ] **工具权限**：
    - get_realtime_quote（实时行情）
    - get_daily_history（历史K线）
    - analyze_trend（技术指标）
    - calculate_ma（均线计算）
    - get_volume_analysis（量能分析）
    - analyze_pattern（K线形态）
    - get_chip_distribution（筹码分布）
    - get_analysis_context（历史分析）
  - [ ] **输出格式**：
    ```json
    {
      "signal": "strong_buy|buy|hold|sell|strong_sell",
      "confidence": 0.0-1.0,
      "reasoning": "2-3句总结",
      "key_levels": {
        "support": <float>,
        "resistance": <float>,
        "stop_loss": <float>
      },
      "trend_score": 0-100,
      "ma_alignment": "bullish|neutral|bearish",
      "volume_status": "heavy|normal|light",
      "pattern": "<检测到的形态或none>"
    }
    ```
  - [ ] **工作流程**：
    1. 获取实时行情+历史K线（如未提供）
    2. 运行趋势分析（均线排列、MACD、RSI）
    3. 分析量能和筹码分布
    4. 识别图表形态
    5. 输出JSON意见
  - [ ] **最大步骤数**：6步
  - [ ] **超时建议**：300秒

- [ ] **DecisionAgent** - 决策Agent
  - [ ] 意见汇总
  - [ ] 决策生成
  - [ ] Dashboard构建
  - [ ] **职责定义**：
    - 汇聚Technical+Intel+Risk+Skill Agent的意见
    - 生成最终决策仪表盘JSON
    - 生成可操作的买入/持有/卖出建议及价位
  - [ ] **工具权限**：无（纯综合分析，仅依赖上下文）
  - [ ] **信号权重规则**：
    - Technical意见权重：~40%
    - Intel/情绪权重：~30%
    - Risk标记权重：~30%（负面覆盖：高严重性风险将信号限制为hold）
    - Skill意见权重：~20%（按比例降低其他权重）
  - [ ] **评分映射**：
    - 80-100: buy（所有条件满足，高置信度）
    - 60-79: buy（大部分正面，小警告）
    - 40-59: hold（混合信号或风险存在）
    - 20-39: sell（负面趋势+风险）
    - 0-19: sell（重大风险+看跌）
  - [ ] **可操作性护栏**：
    - 不要仅因单日涨跌直接翻转buy/sell
    - 操作建议基于支撑/阻力、量能/筹码、主力资金流、风险标记
    - 价格在支撑阻力间且资金流不明确时，倾向hold/watch/震荡/洗盘观察
    - Buy需要支撑确认或带量突破阻力
    - Sell需要支撑失败、持续主力流出或明显风险
  - [ ] **输出格式**：
    ```json
    {
      "stock_name": "股票中文名",
      "sentiment_score": 0-100整数,
      "trend_prediction": "强烈看多/看多/震荡/看空/强烈看空",
      "operation_advice": "买入/加仓/持有/减仓/卖出/观望",
      "decision_type": "buy|hold|sell",
      "confidence_level": "高/中/低",
      "dashboard": {
        "core_conclusion": {...},
        "data_perspective": {...},
        "intelligence": {...},
        "battle_plan": {...},
        "phase_decision": {...}
      },
      "analysis_summary": "100字综合摘要",
      "key_points": ["要点1", "要点2", ...],
      "risk_warning": "风险提示"
    }
    ```
  - [ ] **最大步骤数**：3步（纯综合，无需多工具调用）
  - [ ] **超时建议**：300秒
  - [ ] **对话模式**：支持chat模式，返回自然语言而非JSON

#### 推荐实现的Agent

- [ ] **IntelAgent** - 情报Agent
  - [ ] 新闻搜索
  - [ ] 风险识别
  - [ ] 催化剂分析
  - [ ] **职责定义**：
    - 搜索最新新闻和公告
    - 运行综合情报搜索
    - 检测风险事件（减持、业绩预警、监管）
    - 总结情绪和催化剂
  - [ ] **工具权限**：
    - search_stock_news（股票新闻）
    - search_comprehensive_intel（综合情报）
    - get_stock_info（基本信息）
    - get_capital_flow（主力资金流，仅A股）
  - [ ] **风险检测优先级**：
    1. 内部人/大股东减持
    2. 业绩预警或预亏公告
    3. 监管处罚或调查
    4. 行业政策逆风
    5. 大额解禁
    6. PE估值异常
    7. 持续主力净流出
  - [ ] **资金流解读（仅A股）**：
    - main_net_inflow > 0: 看涨信号（主力净流入）
    - main_net_inflow < 0: 看跌信号（主力净流出）
    - inflow_5d / inflow_10d: 中期积累或派发趋势
  - [ ] **输出格式**：
    ```json
    {
      "signal": "strong_buy|buy|hold|sell|strong_sell",
      "confidence": 0.0-1.0,
      "reasoning": "2-3句新闻/情绪/资金流总结",
      "risk_alerts": ["风险1", "风险2"],
      "positive_catalysts": ["催化剂1", "催化剂2"],
      "sentiment_label": "very_positive|positive|neutral|negative|very_negative",
      "capital_flow_signal": "inflow|outflow|neutral|not_available",
      "key_news": [
        {"title": "...", "impact": "positive|negative|neutral"}
      ]
    }
    ```
  - [ ] **数据缓存**：将parsed结果缓存到ctx.data["intel_opinion"]，供RiskAgent复用
  - [ ] **最大步骤数**：4步
  - [ ] **超时建议**：200秒

- [ ] **RiskAgent** - 风险Agent
  - [ ] 风险评估
  - [ ] 风险标记
  - [ ] 风险覆盖
  - [ ] **职责定义**：
    - 扫描内部人减持、业绩预警、监管行动
    - 检查估值异常（PE/PB极端）
    - 评估解禁风险
    - 生成可覆盖或降级其他Agent信号的风险标记
  - [ ] **工具权限**：
    - search_stock_news（新闻搜索）
    - get_realtime_quote（实时行情）
    - get_stock_info（基本信息）
  - [ ] **强制风险检查**：
    1. 内部人/大股东活动 — 减持、质押
    2. 业绩预警 — 预亏、业绩变脸
    3. 监管 — 处罚、调查、违规
    4. 行业政策 — 逆风、行业打击
    5. 解禁 — 30天内大额解禁
    6. 估值极端 — PE>100或负值、PB>10（标记异常）
    7. 技术警告 — 死叉、破关键支撑
  - [ ] **严重性级别**：
    - "high": 存在性或重大风险（诉讼、欺诈、大规模内部人卖出）
    - "medium": 显著关注（业绩miss、解禁、行业逆风）
    - "low": 轻微或信息性（分析师降级、小额内部人卖出）
  - [ ] **输出格式**：
    ```json
    {
      "risk_level": "high|medium|low|none",
      "risk_score": 0-100,
      "flags": [
        {
          "category": "insider|earnings|regulatory|industry|lockup|valuation|technical",
          "severity": "high|medium|low",
          "description": "清晰风险描述",
          "source": "信息来源"
        }
      ],
      "veto_buy": true|false,
      "reasoning": "2-3句整体风险评估",
      "signal_adjustment": "none|downgrade_one|downgrade_two|veto"
    }
    ```
  - [ ] **风险标记传播**：将flags中的每个标记添加到ctx.risk_flags
  - [ ] **信号映射**：
    - none → buy
    - low → hold
    - medium → sell
    - high → strong_sell
  - [ ] **最大步骤数**：4步
  - [ ] **超时建议**：150秒

#### 可选实现的Agent

- [ ] **PortfolioAgent** - 组合Agent
  - [ ] 组合层面风险评估
  - [ ] 资产配置建议
  - [ ] 相关性分析
  
- [ ] **FundamentalAgent** - 基本面Agent
  - [ ] 财务指标分析
  - [ ] 估值模型
  - [ ] 行业对比
  
- [ ] **SentimentAgent** - 情绪Agent
  - [ ] 社交媒体情绪
  - [ ] 舆情监控
  - [ ] 情绪指标计算

- [ ] **SkillAgent** - 技能评估Agent（可选高级特性）
  - [ ] **职责定义**：评估单个交易技能对股票的适用性
  - [ ] **动态创建**：由SkillRouter选择技能后动态实例化
  - [ ] **工具权限**：继承技能定义中的required_tools
  - [ ] **输出格式**：
    ```json
    {
      "skill_id": "<技能ID>",
      "signal": "strong_buy|buy|hold|sell|strong_sell",
      "confidence": 0.0-1.0,
      "conditions_met": ["满足的条件列表"],
      "conditions_missed": ["未满足的条件列表"],
      "score_adjustment": -20到+20,
      "reasoning": "2-3句技能评估"
    }
    ```
  - [ ] **最大步骤数**：4步
  - [ ] **命名规则**：agent_name = "skill_{skill_id}"

### 工具实现清单

#### 数据工具

- [ ] `get_realtime_quote` - 获取实时行情
- [ ] `get_daily_history` - 获取历史K线
- [ ] `get_chip_distribution` - 获取筹码分布
- [ ] `get_stock_info` - 获取股票信息

#### 分析工具

- [ ] `analyze_trend` - 分析技术指标
- [ ] `analyze_pattern` - 分析K线形态
- [ ] `calculate_ma` - 计算均线
- [ ] `get_volume_analysis` - 量能分析

#### 搜索工具

- [ ] `search_stock_news` - 搜索新闻
- [ ] `search_comprehensive_intel` - 综合情报

#### 市场工具

- [ ] `get_market_indices` - 市场指数
- [ ] `get_sector_rankings` - 板块排名

---

## 最佳实践建议

### 1. Agent设计原则

- **单一职责**：每个Agent只负责一个分析维度
- **明确接口**：清晰定义输入输出
- **容错设计**：优雅处理失败和降级
- **可观测性**：记录详细的执行追踪

### 2. 通信设计原则

- **最小共享**：只共享必要的数据
- **结构化输出**：使用AgentOpinion统一格式
- **版本兼容**：meta字段向后兼容
- **数据验证**：验证共享数据的完整性

### 3. 执行流程原则

- **渐进式执行**：按依赖顺序执行Agent
- **超时保护**：设置合理的超时和预算
- **降级优先**：优先降级而非终止
- **结果验证**：验证最终结果的完整性

### 4. 配置管理原则

- **配置驱动**：通过配置控制行为
- **环境隔离**：不同环境不同配置
- **动态加载**：支持运行时配置更新
- **验证机制**：验证配置的有效性

### 5. 监控追踪原则

- **全链路追踪**：记录完整的执行路径
- **性能统计**：收集性能指标
- **错误分类**：分类统计错误类型
- **可视化展示**：提供可视化监控界面

---

## 扩展方向

### 1. 动态Agent注册

支持运行时动态注册新Agent，无需修改编排器代码。

### 2. Agent版本管理

支持Agent版本切换和回滚，便于迭代优化。

### 3. 分布式执行

支持Agent分布式执行，提升大规模分析性能。

### 4. Agent市场

构建Agent市场，支持第三方Agent共享和交易。

### 5. AI Agent生成

使用AI自动生成新的Agent实现，降低开发成本。

---

## 总结

本设计文档提供了一套完整的、健壮的多Agent系统架构设计方案，参考了 `daily_stock_analysis` 项目的实际实现经验，涵盖了：

1. **核心组件设计**：编排器、Agent、上下文、工具等
2. **通信机制**：数据传递、消息格式、意见聚合
3. **执行流程**：标准流程、并行执行、降级策略
4. **错误处理**：错误分类、恢复策略、降级机制
5. **监控追踪**：执行追踪、性能监控、进度回调
6. **配置管理**：配置文件、加载机制、验证规则
7. **实现清单**：详细的实现任务列表

这套架构可以应用于任何需要多Agent协作的场景，不仅限于股票分析系统。

---

## 附录

### A. 代码示例

参考 `daily_stock_analysis/src/agent/` 目录下的实际实现代码。

### B. 配置示例

参考 `orchestrator_config.yaml` 配置文件示例。

### C. 使用示例

```python
# 创建编排器
orchestrator = AgentOrchestrator(
    config=config,
    tool_registry=registry,
    llm_adapter=adapter,
    skill_manager=skill_manager,
)

# 执行分析
result = orchestrator.run(
    task="分析股票600519的投资机会",
    context={
        "stock_code": "600519",
        "stock_name": "贵州茅台",
        "skills": ["bull_trend"],
    }
)

# 处理结果
if result.success:
    dashboard = result.dashboard
    print(f"决策: {dashboard['decision_type']}")
    print(f"置信度: {dashboard['confidence_level']}")
else:
    print(f"分析失败: {result.error}")
```

---

**文档版本**: v1.0
**创建日期**: 2024-01-15
**作者**: AI Agent System Design Team
**参考项目**: daily_stock_analysis
