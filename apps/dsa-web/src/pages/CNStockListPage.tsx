import type React from 'react';
import { useMemo, useState } from 'react';
import { Badge, Card, InlineAlert, Input, Loading, PageHeader, Pagination, ScrollArea } from '../components/common';
import { useStockIndex } from '../hooks/useStockIndex';
import type { StockIndexItem } from '../types/stockIndex';
import { cn } from '../utils/cn';
import { searchStocks } from '../utils/searchStocks';

type TabKey = 'all' | 'sh' | 'sz' | 'star';

function classifyAStock(item: StockIndexItem): Exclude<TabKey, 'all'> | null {
  const canonical = item.canonicalCode.toUpperCase();
  const code = item.displayCode;
  const isSH = canonical.endsWith('.SH');
  const isSZ = canonical.endsWith('.SZ');
  const isStar = isSH && (code.startsWith('688') || code.startsWith('689'));

  if (isStar) return 'star';
  if (isSH) return 'sh';
  if (isSZ) return 'sz';
  return null;
}

function formatTabLabel(key: TabKey): string {
  if (key === 'all') return '全部';
  if (key === 'sh') return '上证指数';
  if (key === 'sz') return '深证成指';
  return '科创板';
}

function tabBadgeVariant(key: TabKey): 'default' | 'info' | 'history' {
  if (key === 'sh') return 'info';
  if (key === 'sz') return 'history';
  if (key === 'star') return 'default';
  return 'default';
}

function sortByDisplayCode(a: StockIndexItem, b: StockIndexItem): number {
  const aNum = Number.parseInt(a.displayCode, 10);
  const bNum = Number.parseInt(b.displayCode, 10);
  const aIsNum = Number.isFinite(aNum);
  const bIsNum = Number.isFinite(bNum);
  if (aIsNum && bIsNum) return aNum - bNum;
  return a.displayCode.localeCompare(b.displayCode, 'zh-CN');
}

const PAGE_SIZE = 60;

const CNStockListPage: React.FC = () => {
  const { index, loading, error, fallback } = useStockIndex();
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);

  const cnStocks = useMemo(() => {
    return index
      .filter((item) => item.active && item.market === 'CN' && item.assetType === 'stock')
      .sort(sortByDisplayCode);
  }, [index]);

  const tabCounts = useMemo(() => {
    const counts: Record<TabKey, number> = { all: 0, sh: 0, sz: 0, star: 0 };
    for (const item of cnStocks) {
      counts.all += 1;
      const cls = classifyAStock(item);
      if (cls) counts[cls] += 1;
    }
    return counts;
  }, [cnStocks]);

  const baseList = useMemo(() => {
    if (activeTab === 'all') return cnStocks;
    return cnStocks.filter((item) => classifyAStock(item) === activeTab);
  }, [activeTab, cnStocks]);

  const filteredList = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return baseList;

    const suggestions = searchStocks(trimmed, baseList, { limit: 5000, activeOnly: true });
    const byCanonical = new Map(baseList.map((item) => [item.canonicalCode, item]));
    return suggestions
      .map((suggestion) => byCanonical.get(suggestion.canonicalCode))
      .filter((item): item is StockIndexItem => Boolean(item));
  }, [baseList, query]);

  const totalPages = Math.max(1, Math.ceil(filteredList.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const pagedList = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredList.slice(start, start + PAGE_SIZE);
  }, [filteredList, safePage]);

  const tabItems: TabKey[] = ['all', 'sh', 'sz', 'star'];

  return (
    <div className="cn-stock-list-page min-h-screen space-y-4 p-4 md:p-6">
      <PageHeader
        eyebrow="Stock Index"
        title="列表"
        description="按大盘标签浏览 A 股全量股票，支持代码 / 名称 / 拼音搜索。"
        actions={(
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <div className="w-full sm:w-[320px]">
              <Input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCurrentPage(1);
                }}
                placeholder="搜索：600519 / 贵州茅台 / gzmt"
                aria-label="搜索 A股 股票"
              />
            </div>
          </div>
        )}
      />

      {error ? (
        <InlineAlert
          variant="warning"
          message={fallback ? '股票索引加载失败，可能尚未构建前端静态资源或网络异常。' : `股票索引加载失败：${error.message}`}
        />
      ) : null}

      <Card padding="md" className="min-h-[520px] flex flex-col">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {tabItems.map((tab) => {
              const isActive = tab === activeTab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab);
                    setCurrentPage(1);
                  }}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all',
                    isActive
                      ? 'border-cyan/30 bg-cyan/10 text-cyan shadow-[0_0_18px_hsla(var(--primary),0.12)]'
                      : 'border-border/60 bg-elevated/30 text-secondary-text hover:bg-hover hover:text-foreground'
                  )}
                >
                  <span>{formatTabLabel(tab)}</span>
                  <Badge variant={tabBadgeVariant(tab)} className={cn(isActive ? 'border-cyan/30 bg-cyan/12 text-cyan' : '')}>
                    {tabCounts[tab]}
                  </Badge>
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-2 text-xs text-secondary-text">
              <span>结果</span>
              <Badge variant="default">{filteredList.length}</Badge>
            </div>
          </div>
        </div>

        <div className="mt-3 min-h-0 flex-1">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Loading label="加载股票索引中..." />
            </div>
          ) : (
            <ScrollArea className="h-full">
              <div className="divide-y divide-border/50">
                {pagedList.map((item) => {
                  const cls = classifyAStock(item);
                  const boardLabel = cls === 'star' ? '科创' : cls === 'sh' ? '上证' : cls === 'sz' ? '深证' : 'A股';
                  const badgeVariant = cls === 'sh' ? 'info' : cls === 'sz' ? 'history' : cls === 'star' ? 'default' : 'default';
                  return (
                    <div
                      key={item.canonicalCode}
                      className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-hover/50"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate text-sm font-medium text-foreground">{item.nameZh}</span>
                          <Badge variant={badgeVariant}>{boardLabel}</Badge>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-secondary-text">
                          <span className="font-mono">{item.displayCode}</span>
                          <span className="opacity-80">{item.canonicalCode}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="default" className="font-mono">{item.displayCode}</Badge>
                      </div>
                    </div>
                  );
                })}
                {pagedList.length === 0 ? (
                  <div className="px-3 py-12 text-center text-sm text-secondary-text">
                    未找到匹配股票
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          )}
        </div>

        <Pagination
          className="mt-3"
          currentPage={safePage}
          totalPages={totalPages}
          onPageChange={(page) => setCurrentPage(page)}
        />
      </Card>
    </div>
  );
};

export default CNStockListPage;
