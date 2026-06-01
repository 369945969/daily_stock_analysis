import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Check, Eye, FileText, SlidersHorizontal, Star, Trash2 } from 'lucide-react';
import { analysisApi, DuplicateTaskError } from '../api/analysis';
import { agentApi, type SkillInfo } from '../api/agent';
import { historyApi } from '../api/history';
import { Badge, Button, Card, Drawer, EmptyState, InlineAlert, Input, Loading, PageHeader, Pagination, ScrollArea } from '../components/common';
import { ReportMarkdownDrawer } from '../components/report/ReportMarkdownDrawer';
import { ReportSummary } from '../components/report/ReportSummary';
import { useStockIndex } from '../hooks/useStockIndex';
import type { StockIndexItem } from '../types/stockIndex';
import type { AnalysisResult, ReportLanguage } from '../types/analysis';
import { getSentimentColor } from '../types/analysis';
import { cn } from '../utils/cn';
import { searchStocks } from '../utils/searchStocks';

type TabKey = 'all' | 'sh' | 'sz' | 'star';
type AnalysisScopeKey = TabKey | 'favorites';

const FAVORITES_STORAGE_KEY = 'dsa.cnStocks.favorites.v1';
const BLACKLIST_STORAGE_KEY = 'dsa.cnStocks.blacklist.v1';
const BATCH_HISTORY_STORAGE_KEY = 'dsa.cnStocks.batchHistory.v1';

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

type BatchItemStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'blacklisted';

type BatchAnalysisItem = {
  seq: number;
  stockCode: string;
  stockName: string;
  canonicalCode: string;
  board: TabKey;
  status: BatchItemStatus;
  sentimentScore?: number;
  operationAdvice?: string;
  trendPrediction?: string;
  idealBuy?: string;
  secondaryBuy?: string;
  stopLoss?: string;
  takeProfit?: string;
  currentPrice?: number;
  changePct?: number;
  recordId?: number;
  report?: AnalysisResult;
  error?: string;
};

type BatchHistoryItem = Omit<BatchAnalysisItem, 'report'>;

type BatchHistoryRun = {
  id: string;
  createdAt: string;
  endedAt: string;
  scope: AnalysisScopeKey;
  scopeLabel: string;
  strategyId: string;
  strategyName: string;
  forceRefresh: boolean;
  maxAnalyzeCount: number;
  total: number;
  cancelled: boolean;
  items: BatchHistoryItem[];
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatSniperLevels(item: { idealBuy?: string; secondaryBuy?: string }): string {
  const parts = [item.idealBuy, item.secondaryBuy].map((v) => (v || '').trim()).filter(Boolean);
  return parts.join(' / ');
}

function formatRunTime(value: string): string {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toLocaleString('zh-CN', { hour12: false });
}

function formatPrice(value?: number): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value < 100 ? value.toFixed(2) : value.toFixed(2);
}

function formatChangePct(value?: number): { text: string; className: string } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { text: '—', className: 'text-muted-text' };
  }
  if (value > 0) return { text: `+${value.toFixed(2)}%`, className: 'text-rose-400' };
  if (value < 0) return { text: `${value.toFixed(2)}%`, className: 'text-emerald-400' };
  return { text: '0.00%', className: 'text-muted-text' };
}

function buildHistoryRunId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const CNStockListPage: React.FC = () => {
  const { index, loading, error, fallback } = useStockIndex();
  const [activeTab, setActiveTab] = useState<TabKey>('all');
  const [query, setQuery] = useState('');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [analysisSkills, setAnalysisSkills] = useState<SkillInfo[]>([]);
  const [selectedStrategyId, setSelectedStrategyId] = useState('');
  const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const strategyMenuRef = useRef<HTMLDivElement | null>(null);
  const strategyButtonRef = useRef<HTMLButtonElement | null>(null);
  const strategyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const strategyInitialFocusIndexRef = useRef<number | null>(null);

  const [analysisScope, setAnalysisScope] = useState<AnalysisScopeKey>('all');
  const [maxAnalyzeCount, setMaxAnalyzeCount] = useState(50);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchTotal, setBatchTotal] = useState(0);
  const [batchDone, setBatchDone] = useState(0);
  const [batchCurrent, setBatchCurrent] = useState<string>('');
  const [batchItems, setBatchItems] = useState<BatchAnalysisItem[]>([]);
  const batchItemsRef = useRef<BatchAnalysisItem[]>([]);
  const [batchError, setBatchError] = useState<string | null>(null);
  const batchCancelRef = useRef(false);
  const [resultQuery, setResultQuery] = useState('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailReport, setDetailReport] = useState<AnalysisResult | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [markdownContext, setMarkdownContext] = useState<{
    recordId: number;
    stockName: string;
    stockCode: string;
    reportLanguage?: ReportLanguage;
  } | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [blacklist, setBlacklist] = useState<Set<string>>(new Set());
  const [batchHistoryRuns, setBatchHistoryRuns] = useState<BatchHistoryRun[]>([]);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(null);
  const currentBatchRunIdRef = useRef<string | null>(null);

  const cnStocks = useMemo(() => {
    return index
      .filter((item) => item.active && item.market === 'CN' && item.assetType === 'stock')
      .sort(sortByDisplayCode);
  }, [index]);

  useEffect(() => {
    batchItemsRef.current = batchItems;
  }, [batchItems]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BATCH_HISTORY_STORAGE_KEY);
      if (!raw) {
        setBatchHistoryRuns([]);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setBatchHistoryRuns([]);
        return;
      }
      setBatchHistoryRuns(parsed as BatchHistoryRun[]);
    } catch {
      setBatchHistoryRuns([]);
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
      if (!raw) {
        setFavorites(new Set());
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setFavorites(new Set());
        return;
      }
      const values = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      setFavorites(new Set(values));
    } catch {
      setFavorites(new Set());
    }
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BLACKLIST_STORAGE_KEY);
      if (!raw) {
        setBlacklist(new Set());
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        setBlacklist(new Set());
        return;
      }
      const values = parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      setBlacklist(new Set(values));
    } catch {
      setBlacklist(new Set());
    }
  }, []);

  const favoriteStocks = useMemo(() => {
    if (favorites.size === 0) return [];
    return cnStocks.filter((item) => favorites.has(item.canonicalCode));
  }, [cnStocks, favorites]);

  const favoriteCount = favoriteStocks.length;

  const toggleFavorite = useCallback((item: StockIndexItem) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(item.canonicalCode)) {
        next.delete(item.canonicalCode);
      } else {
        next.add(item.canonicalCode);
      }
      try {
        window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const toggleBlacklist = useCallback((item: StockIndexItem) => {
    setBlacklist((prev) => {
      const next = new Set(prev);
      if (next.has(item.canonicalCode)) {
        next.delete(item.canonicalCode);
      } else {
        next.add(item.canonicalCode);
      }
      try {
        window.localStorage.setItem(BLACKLIST_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (analysisScope === 'favorites' && favoriteCount === 0) {
      setAnalysisScope('all');
    }
    if (showFavoritesOnly && favoriteCount === 0) {
      setShowFavoritesOnly(false);
    }
  }, [analysisScope, favoriteCount, showFavoritesOnly]);

  useEffect(() => {
    let active = true;
    agentApi.getSkills()
      .then((response) => {
        if (!active) return;
        setAnalysisSkills(response.skills);
        if (response.default_skill_id) {
          setSelectedStrategyId(response.default_skill_id);
        }
      })
      .catch(() => {
        if (!active) return;
        setAnalysisSkills([]);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!strategyMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && strategyMenuRef.current?.contains(target)) {
        return;
      }
      setStrategyMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [strategyMenuOpen]);

  useEffect(() => {
    if (selectedStrategyId && !analysisSkills.some((skill) => skill.id === selectedStrategyId)) {
      setSelectedStrategyId('');
    }
  }, [analysisSkills, selectedStrategyId]);

  const selectedStrategy = useMemo(
    () => analysisSkills.find((skill) => skill.id === selectedStrategyId),
    [analysisSkills, selectedStrategyId],
  );
  const selectedAnalysisSkills = useMemo(
    () => (selectedStrategyId ? [selectedStrategyId] : undefined),
    [selectedStrategyId],
  );
  const strategyOptions = useMemo(
    () => [
      { id: '', name: '默认策略', description: '沿用系统默认分析框架' },
      ...analysisSkills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
      })),
    ],
    [analysisSkills],
  );

  const focusStrategyItem = useCallback((index: number) => {
    const itemCount = strategyOptions.length;
    if (itemCount === 0) {
      return;
    }
    const nextIndex = (index + itemCount) % itemCount;
    strategyItemRefs.current[nextIndex]?.focus();
  }, [strategyOptions.length]);

  const getSelectedStrategyIndex = useCallback(() => {
    const selectedIndex = strategyOptions.findIndex((option) => option.id === selectedStrategyId);
    return selectedIndex >= 0 ? selectedIndex : 0;
  }, [selectedStrategyId, strategyOptions]);

  useEffect(() => {
    strategyItemRefs.current = strategyItemRefs.current.slice(0, strategyOptions.length);
  }, [strategyOptions.length]);

  useEffect(() => {
    if (!strategyMenuOpen) {
      return undefined;
    }

    const targetIndex = strategyInitialFocusIndexRef.current ?? getSelectedStrategyIndex();
    strategyInitialFocusIndexRef.current = null;
    const focusTarget = window.setTimeout(() => focusStrategyItem(targetIndex), 0);
    return () => window.clearTimeout(focusTarget);
  }, [focusStrategyItem, getSelectedStrategyIndex, strategyMenuOpen]);

  const handleStrategyButtonKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const itemCount = strategyOptions.length;
    if (itemCount === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      strategyInitialFocusIndexRef.current = 0;
      setStrategyMenuOpen(true);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      strategyInitialFocusIndexRef.current = itemCount - 1;
      setStrategyMenuOpen(true);
      return;
    }
  }, [strategyOptions.length]);

  const handleStrategyMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const itemCount = strategyOptions.length;
    if (itemCount === 0) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        setStrategyMenuOpen(false);
        strategyButtonRef.current?.focus();
        break;
      case 'ArrowDown':
        event.preventDefault();
        focusStrategyItem((getSelectedStrategyIndex() + 1) % itemCount);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusStrategyItem(getSelectedStrategyIndex() - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusStrategyItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusStrategyItem(itemCount - 1);
        break;
      case 'Tab':
        setStrategyMenuOpen(false);
        break;
      default:
        break;
    }
  }, [focusStrategyItem, getSelectedStrategyIndex, strategyOptions.length]);

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

  const visibleBaseList = useMemo(() => {
    if (!showFavoritesOnly) return baseList;
    if (favorites.size === 0) return [];
    return baseList.filter((item) => favorites.has(item.canonicalCode));
  }, [baseList, favorites, showFavoritesOnly]);

  const filteredList = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return visibleBaseList;

    const suggestions = searchStocks(trimmed, visibleBaseList, { limit: 5000, activeOnly: true });
    const byCanonical = new Map(visibleBaseList.map((item) => [item.canonicalCode, item]));
    return suggestions
      .map((suggestion) => byCanonical.get(suggestion.canonicalCode))
      .filter((item): item is StockIndexItem => Boolean(item));
  }, [query, visibleBaseList]);

  const totalPages = Math.max(1, Math.ceil(filteredList.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const pagedList = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredList.slice(start, start + PAGE_SIZE);
  }, [filteredList, safePage]);

  const tabItems: TabKey[] = ['all', 'sh', 'sz', 'star'];

  const analysisScopeOptions: Array<{ key: AnalysisScopeKey; label: string; disabled?: boolean }> = [
    { key: 'all', label: '全部' },
    { key: 'sh', label: '上证' },
    { key: 'sz', label: '深证' },
    { key: 'star', label: '科创' },
    { key: 'favorites', label: `收藏 ${favoriteCount}`, disabled: favoriteCount === 0 },
  ];

  const resolveScopeStocks = useCallback((scope: AnalysisScopeKey): StockIndexItem[] => {
    if (scope === 'favorites') return favoriteStocks;
    if (scope === 'all') return cnStocks;
    return cnStocks.filter((item) => classifyAStock(item) === scope);
  }, [cnStocks, favoriteStocks]);

  const selectedHistoryRun = useMemo(() => {
    if (!selectedHistoryRunId) return null;
    return batchHistoryRuns.find((run) => run.id === selectedHistoryRunId) ?? null;
  }, [batchHistoryRuns, selectedHistoryRunId]);

  const deleteHistoryRun = useCallback((runId: string) => {
    setBatchHistoryRuns((prev) => {
      const next = prev.filter((run) => run.id !== runId);
      try {
        window.localStorage.setItem(BATCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
    setSelectedHistoryRunId((prev) => (prev === runId ? null : prev));
  }, []);

  const clearHistoryRuns = useCallback(() => {
    setBatchHistoryRuns([]);
    setSelectedHistoryRunId(null);
    try {
      window.localStorage.setItem(BATCH_HISTORY_STORAGE_KEY, JSON.stringify([]));
    } catch {
      // ignore
    }
  }, []);

  const saveBatchHistoryRun = useCallback((run: BatchHistoryRun) => {
    setBatchHistoryRuns((prev) => {
      const next = [run, ...prev].slice(0, 20);
      try {
        window.localStorage.setItem(BATCH_HISTORY_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const stopBatch = useCallback(() => {
    batchCancelRef.current = true;
    setBatchRunning(false);
    setBatchCurrent('');
  }, []);

  const updateBatchItem = useCallback((stockCode: string, patch: Partial<BatchAnalysisItem>) => {
    setBatchItems((prev) => {
      const next = [...prev];
      const idx = next.findIndex((item) => item.stockCode === stockCode);
      if (idx < 0) {
        return prev;
      }
      next[idx] = { ...next[idx], ...patch };
      batchItemsRef.current = next;
      return next;
    });
  }, []);

  const openResultDetail = useCallback((item: BatchAnalysisItem | BatchHistoryItem) => {
    setDetailError(null);
    if ('report' in item && item.report) {
      setDetailReport(item.report);
      setDetailOpen(true);
      return;
    }
    if (!item.recordId) {
      setDetailReport(null);
      setDetailError('该结果未关联可查询的历史记录（recordId），无法打开详情。通常是服务端未落库或未返回记录 ID。');
      setDetailOpen(true);
      return;
    }
    setDetailReport(null);
    setDetailOpen(true);
    historyApi.getDetail(item.recordId)
      .then((report) => {
        const wrapped: AnalysisResult = {
          queryId: report.meta.queryId,
          stockCode: report.meta.stockCode,
          stockName: report.meta.stockName,
          createdAt: report.meta.createdAt,
          report,
        };
        setDetailReport(wrapped);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '获取报告失败';
        setDetailError(message);
      });
  }, []);

  const runSingleAnalysis = useCallback(async (stock: StockIndexItem, seq: number) => {
    const stockCode = stock.displayCode;
    const stockName = stock.nameZh;

    updateBatchItem(stockCode, { status: 'running' });
    setBatchCurrent(`${stockName}(${stockCode})`);

    let taskId: string | null = null;
    try {
      const accepted = await analysisApi.analyzeAsync({
        stockCode,
        stockName,
        originalQuery: stockCode,
        selectionSource: 'manual',
        reportType: 'detailed',
        forceRefresh,
        skills: selectedAnalysisSkills,
      });
      if ('taskId' in accepted && accepted.taskId) {
        taskId = accepted.taskId;
      }
    } catch (caught) {
      if (caught instanceof DuplicateTaskError) {
        taskId = caught.existingTaskId;
      } else {
        throw caught;
      }
    }

    if (!taskId) {
      throw new Error('未获取到任务 ID');
    }

    const maxAttempts = 240;
    const intervalMs = 1500;
    let attempts = 0;

    while (!batchCancelRef.current) {
      attempts += 1;
      if (attempts > maxAttempts) {
        throw new Error('任务超时');
      }

      const status = await analysisApi.getStatus(taskId);
      if (status.status === 'pending' || status.status === 'processing') {
        await sleep(intervalMs);
        continue;
      }
      if (status.status === 'failed') {
        throw new Error(status.error || '分析失败');
      }
      if (status.status === 'completed') {
        if (!status.result) {
          throw new Error('任务已完成但无结果');
        }
        const result = status.result;
        const sentimentScore = result.report.summary?.sentimentScore;
        const operationAdvice = result.report.summary?.operationAdvice;
        const trendPrediction = result.report.summary?.trendPrediction;
        const strategy = result.report.strategy;
        const recordId = result.report.meta.id;
        const currentPrice = result.report.meta.currentPrice;
        const changePct = result.report.meta.changePct;

        updateBatchItem(stockCode, {
          seq,
          status: 'completed',
          report: result,
          recordId,
          sentimentScore,
          operationAdvice,
          trendPrediction,
          idealBuy: strategy?.idealBuy,
          secondaryBuy: strategy?.secondaryBuy,
          stopLoss: strategy?.stopLoss,
          takeProfit: strategy?.takeProfit,
          currentPrice,
          changePct,
          error: undefined,
        });
        return;
      }
    }
    updateBatchItem(stockCode, { status: 'skipped' });
  }, [forceRefresh, selectedAnalysisSkills, updateBatchItem]);

  const startBatch = useCallback(async (scope: AnalysisScopeKey) => {
    if (batchRunning) {
      return;
    }

    setBatchError(null);
    batchCancelRef.current = false;
    setSelectedHistoryRunId(null);
    const runId = buildHistoryRunId();
    currentBatchRunIdRef.current = runId;
    setBatchRunning(true);

    const list = resolveScopeStocks(scope);
    const limit = Math.max(1, Math.min(5000, Number.isFinite(maxAnalyzeCount) ? maxAnalyzeCount : 50));
    const targets = list.slice(0, limit);
    const runCreatedAt = new Date().toISOString();
    const scopeLabel = scope === 'favorites' ? '收藏' : formatTabLabel(scope);
    const runStrategyId = selectedStrategyId;
    const runStrategyName = selectedStrategy?.name || '策略';

    setBatchTotal(targets.length);
    setBatchDone(0);
    setBatchCurrent('');

    const initialItems: BatchAnalysisItem[] = targets.map((item, idx) => {
      const isBlacklisted = blacklist.has(item.canonicalCode);
      return {
        seq: idx,
        stockCode: item.displayCode,
        stockName: item.nameZh,
        canonicalCode: item.canonicalCode,
        board: classifyAStock(item) ?? 'all',
        status: isBlacklisted ? 'blacklisted' : 'queued',
        sentimentScore: isBlacklisted ? 0 : undefined,
        operationAdvice: isBlacklisted ? '黑名单（跳过）' : undefined,
        trendPrediction: isBlacklisted ? '—' : undefined,
      };
    });
    batchItemsRef.current = initialItems;
    setBatchItems(initialItems);

    for (let i = 0; i < targets.length; i += 1) {
      if (batchCancelRef.current) {
        break;
      }
      const stock = targets[i];
      if (blacklist.has(stock.canonicalCode)) {
        setBatchDone((done) => done + 1);
        continue;
      }
      try {
        await runSingleAnalysis(stock, i);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : '分析失败';
        updateBatchItem(stock.displayCode, { status: 'failed', error: message });
      } finally {
        setBatchDone((done) => done + 1);
      }
      await sleep(300);
    }

    const endedAt = new Date().toISOString();
    const snapshotItems: BatchHistoryItem[] = (batchItemsRef.current || []).map((item) => ({
      seq: item.seq,
      stockCode: item.stockCode,
      stockName: item.stockName,
      canonicalCode: item.canonicalCode,
      board: item.board,
      status: item.status,
      sentimentScore: item.sentimentScore,
      operationAdvice: item.operationAdvice,
      trendPrediction: item.trendPrediction,
      idealBuy: item.idealBuy,
      secondaryBuy: item.secondaryBuy,
      stopLoss: item.stopLoss,
      takeProfit: item.takeProfit,
      currentPrice: item.currentPrice,
      changePct: item.changePct,
      recordId: item.recordId,
      error: item.error,
    }));

    if (snapshotItems.length > 0 && currentBatchRunIdRef.current === runId) {
      saveBatchHistoryRun({
        id: runId,
        createdAt: runCreatedAt,
        endedAt,
        scope,
        scopeLabel,
        strategyId: runStrategyId,
        strategyName: runStrategyName,
        forceRefresh,
        maxAnalyzeCount: limit,
        total: targets.length,
        cancelled: batchCancelRef.current,
        items: snapshotItems,
      });
    }

    setBatchRunning(false);
    setBatchCurrent('');
  }, [batchRunning, blacklist, forceRefresh, maxAnalyzeCount, resolveScopeStocks, runSingleAnalysis, saveBatchHistoryRun, selectedStrategy, selectedStrategyId, updateBatchItem]);

  const activeResultItems: Array<BatchAnalysisItem | BatchHistoryItem> = useMemo(() => {
    if (selectedHistoryRun) return selectedHistoryRun.items;
    return batchItems;
  }, [batchItems, selectedHistoryRun]);

  const sortedBatchItems = useMemo(() => {
    const normalizedQuery = resultQuery.trim();
    const filtered = normalizedQuery
      ? activeResultItems.filter((item) =>
        item.stockCode.includes(normalizedQuery) ||
        item.stockName.includes(normalizedQuery) ||
        item.canonicalCode.toUpperCase().includes(normalizedQuery.toUpperCase()))
      : activeResultItems;

    const next = [...filtered];
    const rank = (status: BatchItemStatus) => {
      if (status === 'completed') return 0;
      if (status === 'running') return 1;
      if (status === 'queued') return 2;
      if (status === 'blacklisted') return 3;
      if (status === 'skipped') return 4;
      return 5;
    };
    next.sort((a, b) => {
      const ra = rank(a.status);
      const rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      if (a.status === 'completed' && b.status === 'completed') {
        return (b.sentimentScore ?? -1) - (a.sentimentScore ?? -1);
      }
      if (a.status === 'blacklisted' && b.status === 'blacklisted') {
        return a.seq - b.seq;
      }
      return a.seq - b.seq;
    });
    return next;
  }, [activeResultItems, resultQuery]);

  return (
    <div className="cn-stock-list-page min-h-screen space-y-4 px-4 pb-4 pt-4 md:px-6 md:pb-6 md:pt-4">
      <div className="sticky top-4 z-30">
        <PageHeader
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
      </div>

      {error ? (
        <InlineAlert
          variant="warning"
          message={fallback ? '股票索引加载失败，可能尚未构建前端静态资源或网络异常。' : `股票索引加载失败：${error.message}`}
        />
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(320px,520px)_minmax(0,1fr)]">
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
              <button
                type="button"
                onClick={() => {
                  setShowFavoritesOnly((value) => !value);
                  setCurrentPage(1);
                }}
                className={cn(
                  'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all',
                  showFavoritesOnly
                    ? 'border-amber-400/40 bg-amber-400/10 text-amber-200 shadow-[0_0_18px_rgba(251,191,36,0.12)]'
                    : 'border-border/60 bg-elevated/30 text-secondary-text hover:bg-hover hover:text-foreground'
                )}
              >
                <Star className={cn('h-4 w-4', showFavoritesOnly ? 'text-amber-300' : 'text-muted-text')} fill={showFavoritesOnly ? 'currentColor' : 'none'} />
                <span>收藏</span>
                <Badge variant="default" className={cn(showFavoritesOnly ? 'border-amber-400/40 bg-amber-400/10 text-amber-200' : '')}>
                  {favoriteCount}
                </Badge>
              </button>
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
                    const isFavorite = favorites.has(item.canonicalCode);
                    const isBlacklisted = blacklist.has(item.canonicalCode);
                    return (
                      <button
                        key={item.canonicalCode}
                        type="button"
                        className="w-full text-left flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-hover/50"
                        onClick={() => {
                          setBatchError(null);
                          setResultQuery(item.displayCode);
                        }}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate text-sm font-medium text-foreground">{item.nameZh}</span>
                            <Badge variant={badgeVariant}>{boardLabel}</Badge>
                            {isBlacklisted ? (
                              <Badge variant="danger" size="sm" className="shadow-none">
                                黑名单
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-xs text-secondary-text">
                            <span className="font-mono">{item.displayCode}</span>
                            <span className="opacity-80">{item.canonicalCode}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            aria-label={isBlacklisted ? `移出黑名单 ${item.nameZh}` : `加入黑名单 ${item.nameZh}`}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                              isBlacklisted
                                ? 'border-danger/35 bg-danger/10 text-danger'
                                : 'border-border/60 bg-elevated/30 text-muted-text hover:bg-hover hover:text-foreground'
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleBlacklist(item);
                            }}
                          >
                            <Ban className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label={isFavorite ? `取消收藏 ${item.nameZh}` : `收藏 ${item.nameZh}`}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                              isFavorite
                                ? 'border-amber-400/35 bg-amber-400/10 text-amber-200'
                                : 'border-border/60 bg-elevated/30 text-muted-text hover:bg-hover hover:text-foreground'
                            )}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleFavorite(item);
                            }}
                          >
                            <Star className="h-4 w-4" fill={isFavorite ? 'currentColor' : 'none'} />
                          </button>
                          <Badge variant="default" className="font-mono">{item.displayCode}</Badge>
                        </div>
                      </button>
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

        <Card padding="md" className="min-h-[520px] flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-foreground">批量分析</h2>
              <p className="mt-1 text-xs text-secondary-text">
                {selectedHistoryRun
                  ? `历史：${selectedHistoryRun.scopeLabel} · ${formatRunTime(selectedHistoryRun.createdAt)}`
                  : batchRunning
                    ? `进行中：${batchDone}/${batchTotal}`
                    : `已完成：${batchItems.filter((item) => item.status === 'completed').length}`}
                {batchCurrent ? ` · 当前：${batchCurrent}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {batchRunning ? (
                <button
                  type="button"
                  className="btn-secondary h-9 rounded-xl px-3 text-sm"
                  onClick={stopBatch}
                >
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn-secondary h-9 rounded-xl px-3 text-sm"
                  onClick={() => {
                    setBatchItems([]);
                    batchItemsRef.current = [];
                    setBatchDone(0);
                    setBatchTotal(0);
                    setBatchCurrent('');
                    setBatchError(null);
                    setResultQuery('');
                    setSelectedHistoryRunId(null);
                  }}
                >
                  清空
                </button>
              )}
            </div>
          </div>

          {batchError ? (
            <InlineAlert variant="danger" message={batchError} className="mt-3 rounded-xl px-3 py-2 text-xs shadow-none" />
          ) : null}

          {batchHistoryRuns.length > 0 ? (
            <div className="mt-4 rounded-xl border border-border/60 bg-elevated/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs font-medium text-foreground">历史记录</div>
                <div className="flex items-center gap-2">
                  {batchHistoryRuns.length > 0 ? (
                    <button
                      type="button"
                      className="btn-secondary h-8 rounded-lg px-3 text-xs"
                      onClick={clearHistoryRuns}
                      disabled={batchRunning}
                    >
                      清空历史
                    </button>
                  ) : null}
                  {selectedHistoryRun ? (
                    <button
                      type="button"
                      className="btn-secondary h-8 rounded-lg px-3 text-xs"
                      onClick={() => setSelectedHistoryRunId(null)}
                      disabled={batchRunning}
                    >
                      返回当前
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                {batchHistoryRuns.map((run) => {
                  const isActive = run.id === selectedHistoryRunId;
                  const completed = run.items.filter((item) => item.status === 'completed').length;
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className={cn(
                        'relative flex min-w-[220px] flex-col gap-0.5 rounded-xl border px-3 py-2 text-left transition-colors',
                        isActive
                          ? 'border-cyan/30 bg-cyan/10'
                          : 'border-border/60 bg-surface/40 hover:bg-hover/40'
                      )}
                      onClick={() => setSelectedHistoryRunId(run.id)}
                      disabled={batchRunning}
                    >
                      <button
                        type="button"
                        aria-label="删除历史记录"
                        className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border/60 bg-elevated/30 text-muted-text transition-colors hover:bg-hover hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteHistoryRun(run.id);
                        }}
                        disabled={batchRunning}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      <div className={cn('text-xs font-medium', isActive ? 'text-cyan' : 'text-foreground')}>
                        {run.scopeLabel}
                        <span className="text-muted-text font-normal"> · {run.strategyName}</span>
                      </div>
                      <div className="text-[11px] text-muted-text">
                        {formatRunTime(run.createdAt)}
                        <span className="opacity-80"> · </span>
                        {completed}/{run.total}
                        {run.cancelled ? <span className="opacity-80"> · 已停止</span> : null}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {analysisScopeOptions.map((option) => {
                const isActive = option.key === analysisScope;
                return (
                  <button
                    key={option.key}
                    type="button"
                    className={cn(
                      'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all',
                      isActive
                        ? 'border-cyan/30 bg-cyan/10 text-cyan'
                        : 'border-border/60 bg-elevated/30 text-secondary-text hover:bg-hover hover:text-foreground',
                      option.disabled ? 'opacity-50 cursor-not-allowed hover:bg-elevated/30 hover:text-secondary-text' : ''
                    )}
                    onClick={() => setAnalysisScope(option.key)}
                    disabled={batchRunning || option.disabled}
                  >
                    {option.label}
                  </button>
                );
              })}
              <div className="ml-auto flex items-center gap-2">
                <label className="flex h-10 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-subtle bg-surface/60 px-3 text-xs text-secondary-text select-none transition-colors hover:border-subtle-hover hover:text-foreground">
                  <input
                    type="checkbox"
                    checked={forceRefresh}
                    onChange={(e) => setForceRefresh(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                    disabled={batchRunning}
                  />
                  强制刷新
                </label>
                <div className="w-[120px]">
                  <Input
                    type="number"
                    value={String(maxAnalyzeCount)}
                    onChange={(event) => setMaxAnalyzeCount(Number(event.target.value))}
                    min={1}
                    max={5000}
                    placeholder="数量"
                    aria-label="分析数量上限"
                    disabled={batchRunning}
                    className="h-10"
                  />
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <button
                  ref={strategyButtonRef}
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={strategyMenuOpen}
                  aria-controls={strategyMenuOpen ? 'cn-stocks-strategy-menu' : undefined}
                  onClick={() => setStrategyMenuOpen((open) => !open)}
                  onKeyDown={handleStrategyButtonKeyDown}
                  disabled={batchRunning}
                  className="home-surface-button flex h-10 items-center gap-1.5 rounded-xl px-3 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <SlidersHorizontal className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                  <span className="truncate">{selectedStrategy?.name || '策略'}</span>
                </button>
                {strategyMenuOpen ? (
                  <div
                    id="cn-stocks-strategy-menu"
                    ref={strategyMenuRef}
                    role="menu"
                    aria-labelledby="strategy-menu-button"
                    onKeyDown={handleStrategyMenuKeyDown}
                    className="absolute left-0 top-11 z-[120] max-h-80 w-[min(22rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-subtle bg-elevated p-1.5 text-sm text-foreground shadow-2xl"
                  >
                    {strategyOptions.map((option, idx) => {
                      const selected = selectedStrategyId === option.id;
                      return (
                        <button
                          key={option.id || 'default'}
                          ref={(node) => {
                            strategyItemRefs.current[idx] = node;
                          }}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          tabIndex={-1}
                          onClick={() => {
                            setSelectedStrategyId(option.id);
                            setStrategyMenuOpen(false);
                          }}
                          className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
                        >
                          <Check className={`mt-0.5 h-4 w-4 flex-shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block font-medium">{option.name}</span>
                            <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-text">{option.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <Button
                variant="primary"
                size="sm"
                isLoading={batchRunning}
                loadingText="分析中..."
                onClick={() => void startBatch(analysisScope)}
                disabled={batchRunning || cnStocks.length === 0}
                className="h-10"
              >
                一键分析
              </Button>

              <div className="ml-auto w-full sm:w-[220px]">
                <Input
                  value={resultQuery}
                  onChange={(event) => setResultQuery(event.target.value)}
                  placeholder="筛选结果：代码/名称"
                  aria-label="筛选分析结果"
                  disabled={batchRunning && batchItems.length === 0}
                  className="h-10"
                />
              </div>
            </div>
          </div>

          <div className="mt-4 min-h-0 flex-1">
            {sortedBatchItems.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <EmptyState
                  title="等待批量分析"
                  description="选择范围与策略后，点击一键分析。"
                  className="max-w-xl border-dashed"
                />
              </div>
            ) : (
              <ScrollArea className="h-full">
                <div className="min-w-[760px]">
                  <div className="grid grid-cols-[150px_72px_46px_150px_120px_180px_150px_110px] gap-2 px-2 py-2 text-xs text-muted-text border-b border-border/60 sticky top-0 bg-card/95 backdrop-blur">
                    <div>股票</div>
                    <div className="text-right">评分</div>
                    <div className="text-center">收藏</div>
                    <div>操作建议</div>
                    <div>现价/涨幅</div>
                    <div>狙击点位</div>
                    <div>趋势预测</div>
                    <div className="text-right">操作</div>
                  </div>
                  {sortedBatchItems.map((item) => {
                    const isBlacklisted = item.status === 'blacklisted';
                    const scoreValue = isBlacklisted ? 0 : item.sentimentScore;
                    const color = typeof scoreValue === 'number' ? getSentimentColor(scoreValue) : null;
                    const scoreText = typeof scoreValue === 'number' ? String(scoreValue) : '--';
                    const sniper = formatSniperLevels(item) || '—';
                    const trend = (item.trendPrediction || '').trim() || '—';
                    const advice = (item.operationAdvice || '').trim() || '—';
                    const priceText = formatPrice(isBlacklisted ? undefined : item.currentPrice);
                    const change = formatChangePct(isBlacklisted ? undefined : item.changePct);
                    const statusLabel = item.status === 'queued'
                      ? '排队'
                      : item.status === 'running'
                        ? '分析中'
                        : item.status === 'completed'
                          ? '完成'
                          : item.status === 'blacklisted'
                            ? '黑名单'
                          : item.status === 'skipped'
                            ? '跳过'
                            : '失败';
                    const canOpenDetail = item.status === 'completed';
                    const canOpenMarkdown = Boolean(item.recordId);

                    return (
                      <div
                        key={item.stockCode}
                        className="grid grid-cols-[150px_72px_46px_150px_120px_180px_150px_110px] gap-2 px-2 py-2.5 border-b border-border/40 hover:bg-hover/50"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate text-sm font-medium text-foreground">{item.stockName}</span>
                            <Badge variant="default" size="sm" className="font-mono shadow-none">{item.stockCode}</Badge>
                            {isBlacklisted ? (
                              <Badge variant="danger" size="sm" className="shadow-none">
                                黑名单
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-1 text-[11px] text-muted-text">
                            {statusLabel}
                            {item.error ? ` · ${item.error}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center justify-end">
                          <Badge
                            variant="default"
                            size="sm"
                            className="shadow-none"
                            style={color ? { color, borderColor: `${color}30`, backgroundColor: `${color}10` } : undefined}
                          >
                            {scoreText}
                          </Badge>
                        </div>
                        <div className="flex items-center justify-center">
                          <button
                            type="button"
                            aria-label={favorites.has(item.canonicalCode) ? `取消收藏 ${item.stockName}` : `收藏 ${item.stockName}`}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                              favorites.has(item.canonicalCode)
                                ? 'border-amber-400/35 bg-amber-400/10 text-amber-200'
                                : 'border-border/60 bg-elevated/30 text-muted-text hover:bg-hover hover:text-foreground'
                            )}
                            onClick={() => {
                              const canonical = item.canonicalCode;
                              const stockItem = cnStocks.find((s) => s.canonicalCode === canonical);
                              if (!stockItem) return;
                              toggleFavorite(stockItem);
                            }}
                            disabled={batchRunning}
                          >
                            <Star className="h-4 w-4" fill={favorites.has(item.canonicalCode) ? 'currentColor' : 'none'} />
                          </button>
                        </div>
                        <div className="text-xs text-secondary-text leading-5 line-clamp-2">{advice}</div>
                        <div className="text-xs leading-5">
                          <div className="font-mono text-secondary-text">{priceText}</div>
                          <div className={cn('font-mono text-[11px]', change.className)}>{change.text}</div>
                        </div>
                        <div className="text-xs text-secondary-text leading-5 line-clamp-2">
                          {sniper}
                          {item.stopLoss ? ` · 止损 ${item.stopLoss}` : ''}
                          {item.takeProfit ? ` · 止盈 ${item.takeProfit}` : ''}
                        </div>
                        <div className="text-xs text-secondary-text leading-5 line-clamp-2">{trend}</div>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            aria-label="查看详情"
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                              canOpenDetail
                                ? 'border-border/60 bg-elevated/30 text-foreground hover:bg-hover'
                                : 'border-border/40 bg-elevated/10 text-muted-text opacity-60 cursor-not-allowed'
                            )}
                            disabled={!canOpenDetail}
                            onClick={() => openResultDetail(item)}
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            aria-label="查看 Markdown"
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors',
                              canOpenMarkdown
                                ? 'border-border/60 bg-elevated/30 text-foreground hover:bg-hover'
                                : 'border-border/40 bg-elevated/10 text-muted-text opacity-60 cursor-not-allowed'
                            )}
                            disabled={!canOpenMarkdown}
                            onClick={() => {
                              if (!item.recordId) return;
                              setMarkdownContext({
                                recordId: item.recordId,
                                stockName: item.stockName,
                                stockCode: item.stockCode,
                                reportLanguage: 'report' in item ? item.report?.report.meta.reportLanguage : undefined,
                              });
                            }}
                          >
                            <FileText className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>
        </Card>
      </div>

      <Drawer
        isOpen={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailReport(null);
          setDetailError(null);
        }}
        title={detailReport ? `${detailReport.stockName}（${detailReport.stockCode}）` : '分析详情'}
        width="max-w-4xl"
        zIndex={95}
      >
        {detailError ? (
          <InlineAlert variant="danger" message={detailError} className="rounded-xl px-3 py-2 text-xs shadow-none" />
        ) : detailReport ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              {detailReport.report.meta.id ? (
                <button
                  type="button"
                  className="btn-secondary h-9 rounded-xl px-3 text-sm"
                  onClick={() => {
                    const id = detailReport.report.meta.id;
                    if (!id) return;
                    setMarkdownContext({
                      recordId: id,
                      stockName: detailReport.stockName,
                      stockCode: detailReport.stockCode,
                      reportLanguage: detailReport.report.meta.reportLanguage,
                    });
                  }}
                >
                  查看 Markdown
                </button>
              ) : null}
            </div>
            <ReportSummary data={detailReport} />
          </div>
        ) : (
          <div className="py-8">
            <Loading label="加载报告中..." />
          </div>
        )}
      </Drawer>

      {markdownContext ? (
        <ReportMarkdownDrawer
          key={markdownContext.recordId}
          recordId={markdownContext.recordId}
          stockName={markdownContext.stockName}
          stockCode={markdownContext.stockCode}
          reportLanguage={markdownContext.reportLanguage}
          onClose={() => {
            setMarkdownContext(null);
          }}
        />
      ) : null}
    </div>
  );
};

export default CNStockListPage;
