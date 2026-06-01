/**
 * StockAutocomplete Component
 *
 * Stock code/name autocomplete input box
 * Supports keyboard navigation, IME input method, graceful degradation
 */

import { Component, useMemo, useRef, useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStockIndex } from '../../hooks/useStockIndex';
import { useAutocomplete } from '../../hooks/useAutocomplete';
import { searchStocks } from '../../utils/searchStocks';
import { SuggestionsList } from './SuggestionsList';
import { cn } from '../../utils/cn';
import type { StockIndexItem, StockSuggestion } from '../../types/stockIndex';
import { Badge } from '../common';

const AUTOCOMPLETE_INPUT_CLASS =
  'input-surface input-focus-glow h-11 w-full rounded-xl border bg-transparent px-4 text-sm transition-all focus:outline-none disabled:cursor-not-allowed disabled:opacity-60';

export interface StockAutocompleteProps {
  /** Input value */
  value: string;
  /** Value change callback */
  onChange: (value: string) => void;
  /** Submit callback (code, name, source) */
  onSubmit: (code: string, name?: string, source?: 'manual' | 'autocomplete') => void;
  /** Whether disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Additional CSS class name */
  className?: string;
  mode?: 'autocomplete' | 'dropdown';
}

function FallbackInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = '输入股票代码或名称',
  className,
}: StockAutocompleteProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !disabled && value) {
          onSubmit(value);
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      className={cn(AUTOCOMPLETE_INPUT_CLASS, className)}
      data-autocomplete-mode="fallback"
    />
  );
}

interface StockAutocompleteBoundaryProps extends StockAutocompleteProps {
  children: ReactNode;
}

interface StockAutocompleteBoundaryState {
  hasError: boolean;
}

class StockAutocompleteBoundary extends Component<
  StockAutocompleteBoundaryProps,
  StockAutocompleteBoundaryState
> {
  override state: StockAutocompleteBoundaryState = { hasError: false };

  static getDerivedStateFromError(): StockAutocompleteBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Autocomplete runtime error. Falling back to plain input.', error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      const { children, ...fallbackProps } = this.props;
      void children;
      return <FallbackInput {...fallbackProps} />;
    }

    return this.props.children;
  }
}

function StockAutocompleteInner({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = '输入股票代码或名称',
  className,
  mode = 'autocomplete',
}: StockAutocompleteProps) {
  const { index, loading, fallback } = useStockIndex();
  const isDropdownMode = mode === 'dropdown';
  const filteredIndex = useMemo(() => {
    if (!isDropdownMode) return index;
    return index.filter((item) => item.active && item.market === 'CN' && item.assetType === 'stock');
  }, [index, isDropdownMode]);

  const {
    // query,
    setQuery,
    suggestions,
    isOpen,
    highlightedIndex,
    setHighlightedIndex,
    highlightPrevious,
    highlightNext,
    close,
    // reset,
    isComposing,
    setIsComposing,
    runtimeFallback,
    error: autocompleteError,
  } = useAutocomplete(filteredIndex, {
    minLength: isDropdownMode ? 9999 : undefined,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const prevValueRef = useRef(value);
  const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: string } | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [dropdownHighlightedIndex, setDropdownHighlightedIndex] = useState<number>(-1);
  const [activeTab, setActiveTab] = useState<'all' | 'sh' | 'sz' | 'star'>('all');

  const updateDropdownPosition = () => {
    if (!inputRef.current) {
      setDropdownStyle(null);
      return;
    }

    const rect = inputRef.current.getBoundingClientRect();
    setDropdownStyle({
      top: rect.bottom,
      left: rect.left,
      width: `${rect.width}px`,
    });
  };

  const closeSuggestions = () => {
    if (!isDropdownMode) {
      close();
    }
    setDropdownOpen(false);
    setDropdownStyle(null);
    setDropdownHighlightedIndex(-1);
  };

  // Sync external value with internal query (only when value truly changes)
  useEffect(() => {
    if (isDropdownMode) {
      prevValueRef.current = value;
      return;
    }
    if (prevValueRef.current !== value) {
      setQuery(value);
      prevValueRef.current = value;
    }
  }, [value, setQuery, isDropdownMode]);

  const classifyAStock = (item: StockIndexItem): 'sh' | 'sz' | 'star' | null => {
    const canonical = item.canonicalCode.toUpperCase();
    const code = item.displayCode;
    const isSH = canonical.endsWith('.SH');
    const isSZ = canonical.endsWith('.SZ');
    const isStar = isSH && (code.startsWith('688') || code.startsWith('689'));
    if (isStar) return 'star';
    if (isSH) return 'sh';
    if (isSZ) return 'sz';
    return null;
  };

  const tabCounts = useMemo(() => {
    const counts = { all: 0, sh: 0, sz: 0, star: 0 };
    if (!isDropdownMode) {
      return counts;
    }
    for (const item of filteredIndex) {
      counts.all += 1;
      const cls = classifyAStock(item);
      if (cls) counts[cls] += 1;
    }
    return counts;
  }, [filteredIndex, isDropdownMode]);

  const dropdownSuggestions: StockSuggestion[] = useMemo(() => {
    if (!isDropdownMode) {
      return suggestions;
    }

    const trimmed = value.trim();
    if (trimmed) return [];

    const base = activeTab === 'all'
      ? filteredIndex
      : filteredIndex.filter((item) => classifyAStock(item) === activeTab);

    const sorted = [...base].sort((a, b) => {
      const aNum = Number.parseInt(a.displayCode, 10);
      const bNum = Number.parseInt(b.displayCode, 10);
      const aIsNum = Number.isFinite(aNum);
      const bIsNum = Number.isFinite(bNum);
      if (aIsNum && bIsNum) return aNum - bNum;
      return a.displayCode.localeCompare(b.displayCode, 'zh-CN');
    });

    return sorted.slice(0, 120).map((item) => ({
      canonicalCode: item.canonicalCode,
      displayCode: item.displayCode,
      nameZh: item.nameZh,
      market: item.market,
      matchType: 'fuzzy',
      matchField: 'name',
      score: 1,
    }));
  }, [activeTab, filteredIndex, isDropdownMode, suggestions, value]);

  const searchSuggestions: StockSuggestion[] = useMemo(() => {
    if (!isDropdownMode) return suggestions;
    const trimmed = value.trim();
    if (trimmed.length === 0) return dropdownSuggestions;
    return searchStocks(trimmed, filteredIndex, { limit: 30, activeOnly: true });
  }, [dropdownSuggestions, filteredIndex, isDropdownMode, suggestions, value]);

  const effectiveSuggestions = isDropdownMode ? searchSuggestions : suggestions;
  const effectiveIsOpen = isDropdownMode ? dropdownOpen : isOpen;
  const effectiveHighlightedIndex = isDropdownMode ? dropdownHighlightedIndex : highlightedIndex;
  const effectiveSetHighlightedIndex = isDropdownMode ? setDropdownHighlightedIndex : setHighlightedIndex;

  // Calculate suggestion box position (using fixed positioning)
  useEffect(() => {
    if (!effectiveIsOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(updateDropdownPosition);
    window.addEventListener('resize', updateDropdownPosition);
    window.addEventListener('scroll', updateDropdownPosition, true);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updateDropdownPosition);
      window.removeEventListener('scroll', updateDropdownPosition, true);
    };
  }, [effectiveIsOpen]);

  useEffect(() => {
    if (!autocompleteError) {
      return;
    }

    console.error('Autocomplete runtime fallback activated.', autocompleteError);
  }, [autocompleteError]);

  // Keyboard event handling
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Skip if composing (IME)
    if (isComposing) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (isDropdownMode) {
          setDropdownHighlightedIndex((prev) => {
            if (effectiveSuggestions.length === 0) return -1;
            if (prev >= effectiveSuggestions.length - 1) return 0;
            return prev + 1;
          });
        } else {
          highlightNext();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (isDropdownMode) {
          setDropdownHighlightedIndex((prev) => {
            if (effectiveSuggestions.length === 0) return -1;
            if (prev <= 0) return effectiveSuggestions.length - 1;
            return prev - 1;
          });
        } else {
          highlightPrevious();
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (effectiveHighlightedIndex >= 0 && effectiveSuggestions[effectiveHighlightedIndex]) {
          // Select highlighted item
          const selected = effectiveSuggestions[effectiveHighlightedIndex];
          onChange(selected.displayCode);
          closeSuggestions();
          onSubmit(selected.canonicalCode, selected.nameZh, 'autocomplete');
        } else {
          // Submit directly
          onSubmit(value);
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeSuggestions();
        break;
    }
  };

  // IME handling
  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  // Delay closing on blur (avoid immediate close when clicking suggestion items)
  const handleBlur = () => {
    setTimeout(() => closeSuggestions(), 200);
  };

  // Fallback mode: use normal input
  if (fallback || loading || runtimeFallback) {
    return (
      <FallbackInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        disabled={disabled}
        placeholder={placeholder}
        className={className}
      />
    );
  }

  return (
    <div className="relative stock-autocomplete">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onFocus={() => {
          if (isDropdownMode) {
            setDropdownOpen(true);
            setDropdownHighlightedIndex(-1);
            updateDropdownPosition();
            return;
          }
          if (isOpen) updateDropdownPosition();
        }}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          AUTOCOMPLETE_INPUT_CLASS,
          effectiveIsOpen && "rounded-b-none",
          className
        )}
        aria-autocomplete="none"
        role="combobox"
        aria-expanded={effectiveIsOpen}
        aria-haspopup="listbox"
        aria-controls="suggestions-list"
      />

      {/* Loading indicator */}
      {loading && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <div className="w-4 h-4 border-2 border-cyan/20 border-t-cyan rounded-full animate-spin" />
        </div>
      )}

      {/* Suggestion dropdown list */}
      {effectiveIsOpen && dropdownStyle && createPortal(
        <div style={{ position: 'fixed', ...dropdownStyle }} className="z-[100]">
          {isDropdownMode ? (
            <div
              className="rounded-t-lg border-x border-t border-[var(--border-accent)]"
              style={{ backgroundColor: 'hsl(var(--card) / 0.85)' }}
            >
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                {(['all', 'sh', 'sz', 'star'] as const).map((tab) => {
                  const label = tab === 'all' ? '全部' : tab === 'sh' ? '上证' : tab === 'sz' ? '深证' : '科创';
                  const isActive = tab === activeTab;
                  return (
                    <button
                      key={tab}
                      type="button"
                      className={cn(
                        'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all',
                        isActive
                          ? 'border-cyan/30 bg-cyan/10 text-cyan'
                          : 'border-border/60 bg-elevated/30 text-secondary-text hover:bg-hover hover:text-foreground'
                      )}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setActiveTab(tab);
                        setDropdownHighlightedIndex(-1);
                        updateDropdownPosition();
                      }}
                    >
                      <span>{label}</span>
                      <Badge variant="default" size="sm" className={cn(isActive ? 'border-cyan/30 bg-cyan/12 text-cyan shadow-none' : 'shadow-none')}>
                        {tabCounts[tab]}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          <SuggestionsList
            suggestions={effectiveSuggestions}
            highlightedIndex={effectiveHighlightedIndex}
            onSelect={(s) => {
              onChange(s.displayCode);
              closeSuggestions();
              onSubmit(s.canonicalCode, s.nameZh, 'autocomplete');
            }}
            onMouseEnter={(index) => effectiveSetHighlightedIndex(index)}
          />
        </div>,
        document.body
      )}
    </div>
  );
}

export function StockAutocomplete(props: StockAutocompleteProps) {
  return (
    <StockAutocompleteBoundary {...props}>
      <StockAutocompleteInner {...props} />
    </StockAutocompleteBoundary>
  );
}

export default StockAutocomplete;
