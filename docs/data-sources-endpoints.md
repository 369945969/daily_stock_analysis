# 数据源头与外部访问地址一览

本表用于快速回答三个问题：

- 数据源头来自哪个平台/服务
- 访问的外部地址（URL / Host:Port / WebSocket）是什么
- 能拿到什么金融数据、支持哪些市场（A 股/港股/美股/加密货币）

说明：

- “由 SDK/第三方库内部决定”表示本仓库未写死具体 URL（例如 yfinance/akshare/efinance/tickflow/tushare 等），实际访问地址由其依赖库实现或运行时配置决定。
- 示例以“请求形状/关键字段”为主，避免把密钥写进文档。

| 数据源/平台 | 外部地址（代码里可见/可配置） | 获取数据（举例） | 支持市场 | 请求/返回示例（形状） | 代码位置 |
|---|---|---|---|---|---|
| 新浪财经（直连） | `http://hq.sinajs.cn/list=sh600519`（批量：`...list=sh600519,sz000001`） | 实时行情（字段较少：最新价、今开、昨收、最高、最低、成交量额等） | A 股 | 请求：`GET http://hq.sinajs.cn/list=sh600519`；返回：`var hq_str_sh600519="贵州茅台,1866.000,1870.000,...,日期,时间"` | [akshare_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/akshare_fetcher.py#L1053-L1186) |
| 腾讯财经（直连） | `http://qt.gtimg.cn/q=sh600519`（批量：`...q=sh600519,sz000001`） | 实时行情（字段略多，通常含换手率等；无完整估值字段） | A 股 | 请求：`GET http://qt.gtimg.cn/q=sh600519`；返回：文本，字段用 `~` 分隔（由代码解析为统一 quote） | [akshare_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/akshare_fetcher.py#L1204-L1348) |
| Tushare Pro | 默认：`http://api.tushare.pro`（构造参数 `api_url` 可覆盖） | 市场统计、板块排行、资金流等（取决于 token/积分/接口） | A 股为主（部分接口覆盖港股） | 请求：由 tushare SDK 组装；返回：DataFrame（再被系统规范化/聚合） | [tushare_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/tushare_fetcher.py#L78-L90) |
| Stooq（yfinance 兜底） | 最新：`https://stooq.com/q/l/?s={symbol}`；历史：`https://stooq.com/q/d/l/?s={symbol}&i=d` | 报价/日线历史（作为 yfinance 失败后的兜底） | 美股为主（按代码兜底逻辑） | 请求：`GET https://stooq.com/q/d/l/?s=aapl.us&i=d`；返回：CSV（再被解析/规范化） | [yfinance_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/yfinance_fetcher.py#L439-L468) |
| PyTDX 通达信行情（TCP 直连） | 内置 `ip:port` 列表（可用 `PYTDX_SERVERS` 覆盖）：如 `119.147.212.81:7709`、`101.227.73.20:7709` 等 | 行情/K 线数据（兜底通道） | A 股 | 连接：TCP 到 `ip:port`；返回：pytdx 协议数据（再被转换为 DataFrame/统一字段） | [pytdx_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/pytdx_fetcher.py#L120-L129) |
| Finnhub（HTTP API） | Base URL：`https://finnhub.io/api/v1` | 日线 K 线、实时报价 | 美股 | 日线：`GET /stock/candle?symbol=AAPL&resolution=D&from=...&to=...&token=...`；报价：`GET /quote?symbol=AAPL&token=...` | [finnhub_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/finnhub_fetcher.py#L24-L112) |
| AlphaVantage（HTTP API） | `https://www.alphavantage.co/query` | 日线 K 线、实时报价（额度较紧） | 美股 | 日线：`GET /query?function=TIME_SERIES_DAILY&symbol=AAPL&apikey=...` | [alphavantage_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/alphavantage_fetcher.py#L24-L60) |
| Longbridge 长桥 OpenAPI（HTTP + WS） | CN：`https://openapi.longbridge.cn`、`wss://openapi-quote.longbridge.cn/v2`、`wss://openapi-trade.longbridge.cn/v2`；HK/US：`https://openapi.longbridge.com`、`wss://openapi-quote.longbridge.com/v2`、`wss://openapi-trade.longbridge.com/v2`（也可用 `LONGBRIDGE_*_URL` 覆盖） | 港/美实时行情、历史K线、静态信息（用于补齐换手率/PE/市值等） | 港股/美股 | 请求：由 longbridge SDK 组装（HTTP/WS）；返回：SDK 对象（再被转换为统一 quote / DataFrame） | [longbridge_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/longbridge_fetcher.py#L68-L79) |
| Bocha 博查搜索 | `https://api.bocha.cn/v1/web-search` | 新闻/网页搜索结果（标题、摘要、来源、URL、时间等） | 不限（取决于 query） | `POST /v1/web-search` JSON：`{"query":"首创环保 600008 新闻","freshness":"oneWeek","summary":true,"count":10}`；返回：JSON（再转为统一 SearchResult 列表） | [search_service.py](file:///Users/jack/python/daily_stock_analysis/src/search_service.py#L888-L1010) |
| Brave Search | `https://api.search.brave.com/res/v1/web/search` | 新闻/网页搜索结果 | 不限 | `GET /res/v1/web/search?q=...&count=...&freshness=pw`；返回：JSON | [search_service.py](file:///Users/jack/python/daily_stock_analysis/src/search_service.py#L1490-L1560) |
| Anspire Search | `https://plugin.anspire.cn/api/ntsearch/search` | 新闻/情报搜索结果 | 不限 | `GET /api/ntsearch/search?query=...&top_k=...&FromTime=...&ToTime=...`；返回：JSON | [search_service.py](file:///Users/jack/python/daily_stock_analysis/src/search_service.py#L1070-L1165) |
| MiniMax Web Search | `https://api.minimaxi.com/v1/coding_plan/search` | 结构化网页搜索结果（title/link/snippet/date） | 不限 | `POST /v1/coding_plan/search` JSON；返回：JSON | [search_service.py](file:///Users/jack/python/daily_stock_analysis/src/search_service.py#L1258-L1310) |
| SearXNG（自建/公共实例） | `SEARXNG_BASE_URLS`（你配置的实例 URL）；未配置时自动发现公共实例（地址不固定） | 网页搜索结果 | 不限 | `GET {base_url}/search?q=...&format=json`（以 provider 实现为准） | [search_service.py](file:///Users/jack/python/daily_stock_analysis/src/search_service.py#L2229-L2251) |
| Adanos Social Sentiment | 默认：`https://api.adanos.org`（可用 `SOCIAL_SENTIMENT_API_URL` 覆盖） | Reddit / X / Polymarket 情绪/热度（趋势与单 ticker 报告） | 美股（ticker） | 示例：`GET /reddit/stocks/v1/report/TSLA`、`GET /x/stocks/v1/trending`、`GET /polymarket/stocks/v1/trending` | [social_sentiment_service.py](file:///Users/jack/python/daily_stock_analysis/src/services/social_sentiment_service.py#L152-L180) |
| 股票自动补全索引（GitHub Raw） | `https://raw.githubusercontent.com/ZhuLinsen/daily_stock_analysis/main/apps/dsa-web/public/stocks.index.json` | 股票元数据索引（代码/名称/市场/别名等） | A 股/港股/美股/北交所（列表层面） | `GET .../stocks.index.json`；返回：压缩数组结构（再被解析/缓存） | [stock_index_remote_service.py](file:///Users/jack/python/daily_stock_analysis/src/services/stock_index_remote_service.py#L21-L30) |
| efinance（东方财富，经 efinance 库） | 由 efinance 库内部决定（本仓库未写死 URL） | A 股/ETF 日线K线、实时报价、基本信息等 | A 股/ETF | 请求/返回：由 efinance SDK 封装（最终转为 DataFrame/统一 quote） | [efinance_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/efinance_fetcher.py) |
| akshare（多站点，经 akshare 库） | 由 akshare 库内部决定（本仓库未写死 URL；仅“新浪/腾讯直连”在上表） | A 股为主：K线/实时/筹码/基本面等大量特色数据 | A 股为主（部分港股） | 请求/返回：由 akshare SDK 封装（最终转为 DataFrame/统一结构） | [akshare_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/akshare_fetcher.py) |
| yfinance（Yahoo Finance，经 yfinance 库） | 由 yfinance 库内部决定（本仓库未写死 URL；仅 Stooq 兜底 URL 在上表） | K 线/报价/海外基础数据（能力随 Yahoo/库变化） | 美股/港股为主 | 请求/返回：由 yfinance SDK 封装（最终转为 DataFrame/统一结构） | [yfinance_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/yfinance_fetcher.py) |
| TickFlow（经 tickflow SDK） | 由 tickflow SDK 内部决定（本仓库未写死 API Base URL） | A 股主要指数行情、市场宽度统计 | A 股 | 请求/返回：由 tickflow SDK 封装（最终转为 dict/list） | [tickflow_fetcher.py](file:///Users/jack/python/daily_stock_analysis/data_provider/tickflow_fetcher.py) |

## 加密货币（Crypto）

当前仓库未发现专门的“加密货币行情/K线/交易所 API”数据源实现（例如 Binance/Coinbase/CoinGecko 等），因此：

- 不提供稳定的加密货币行情数据源地址清单
- 只能通过“搜索引擎数据源”（Bocha/Brave/Anspire/SearXNG 等）检索加密相关新闻/网页信息

