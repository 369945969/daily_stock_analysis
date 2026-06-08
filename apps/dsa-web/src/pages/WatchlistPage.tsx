import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { AppPage, Button, Card, EmptyState, InlineAlert, Input, Loading, PageHeader } from '../components/common';
import { useWatchlist } from '../hooks/useWatchlist';
import { useStockPoolStore } from '../stores/stockPoolStore';
import { normalizeStockCode } from '../utils/stockCode';

const WatchlistPage: React.FC = () => {
  const navigate = useNavigate();
  const watchlist = useWatchlist();
  const [input, setInput] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const { submitAnalysis, isAnalyzing, duplicateError, error, clearInlineMessages, clearError } = useStockPoolStore(
    useShallow((s) => ({
      submitAnalysis: s.submitAnalysis,
      isAnalyzing: s.isAnalyzing,
      duplicateError: s.duplicateError,
      error: s.error,
      clearInlineMessages: s.clearInlineMessages,
      clearError: s.clearError,
    })),
  );

  useEffect(() => {
    document.title = '自选 - DSA';
  }, []);

  const codes = useMemo(() => {
    const normalized = watchlist.watchlistCodes
      .map((code) => normalizeStockCode(String(code ?? '')))
      .filter(Boolean);
    normalized.sort();
    return normalized;
  }, [watchlist.watchlistCodes]);

  const handleAdd = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setLocalError(null);
    try {
      await watchlist.addToWatchlist(trimmed);
      setInput('');
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : '加入自选失败');
    }
  }, [watchlist, setInput]);

  const handleAnalyze = useCallback(async (code: string) => {
    clearInlineMessages();
    clearError();
    await submitAnalysis({
      stockCode: code,
      selectionSource: 'manual',
    });
    navigate('/');
  }, [clearError, clearInlineMessages, navigate, submitAnalysis]);

  return (
    <AppPage className="space-y-4">
      <PageHeader
        eyebrow="自选"
        title="自选股票"
        description="管理自选队列，并快速跳转到首页发起分析。"
        actions={(
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void watchlist.refresh()}
            disabled={watchlist.isLoading}
          >
            刷新
          </Button>
        )}
      />

      {localError ? (
        <InlineAlert variant="danger" title="请求失败" message={localError} />
      ) : null}
      {watchlist.actionMessage ? (
        <InlineAlert variant="info" title="提示" message={watchlist.actionMessage} />
      ) : null}
      {duplicateError ? (
        <InlineAlert variant="warning" title="重复任务" message={duplicateError} />
      ) : null}
      {error ? (
        <InlineAlert variant="danger" title={error.title || '分析失败'} message={error.message || error.rawMessage || '分析失败'} />
      ) : null}

      <Card className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入股票代码，回车加入自选"
              disabled={watchlist.isActioning}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleAdd(input);
                }
              }}
            />
          </div>
          <Button
            onClick={() => void handleAdd(input)}
            disabled={!input.trim() || watchlist.isActioning}
            className="md:w-28"
          >
            加入自选
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-white/6 px-4 py-3">
          <div className="text-sm font-medium text-foreground">自选列表</div>
          <div className="text-xs text-secondary-text">{codes.length} 只</div>
        </div>

        {watchlist.isLoading ? (
          <div className="p-6">
            <Loading label="加载自选中..." />
          </div>
        ) : codes.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="暂无自选股票"
              description="在上方输入股票代码或名称加入自选。"
              className="border-dashed"
            />
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {codes.map((code) => {
              return (
                <div key={code} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium text-foreground">{code}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleAnalyze(code)}
                      disabled={isAnalyzing}
                      className={isAnalyzing ? 'opacity-80 min-w-20' : 'min-w-20'}
                    >
                      分析
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void watchlist.removeFromWatchlist(code)}
                      disabled={watchlist.isActioning}
                    >
                      移除
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </AppPage>
  );
};

export default WatchlistPage;
