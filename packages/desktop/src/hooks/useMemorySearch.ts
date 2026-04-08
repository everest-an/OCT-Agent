import { useState, useCallback } from 'react';
import type { KnowledgeCard, MemoryEvent } from '../components/memory/memory-helpers';

export interface MemorySearchState {
  searchQuery: string;
  searchResults: any[] | null;
  searching: boolean;
}

export interface MemorySearchActions {
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  setSearchResults: React.Dispatch<React.SetStateAction<any[] | null>>;
  handleSearch: () => Promise<void>;
}

export type UseMemorySearchReturn = MemorySearchState & MemorySearchActions;

/**
 * Manages search state and search execution for both timeline and knowledge tabs.
 * Extracted from Memory.tsx to reduce file size.
 */
export function useMemorySearch(
  api: any,
  activeTab: string,
  setEvents: React.Dispatch<React.SetStateAction<MemoryEvent[]>>,
  setEventsTotal: React.Dispatch<React.SetStateAction<number>>,
): UseMemorySearchReturn {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    if (activeTab !== 'timeline' && activeTab !== 'knowledge') {
      return;
    }
    setSearching(true);
    if (api) {
      try {
        if (activeTab === 'timeline') {
          const result = await api.memoryGetEvents({ limit: 50, search: searchQuery });
          if (result?.items) {
            setEvents(result.items);
            setEventsTotal(result.total || result.items.length);
          }
          setSearchResults([]);
        } else {
          const result = await api.memorySearch(searchQuery);
          const content = result?.result?.content;
          const textBlock = content?.[0]?.text || '';
          const metaBlock = content?.[1]?.text || '';

          let parsedMeta: any = {};
          try { parsedMeta = JSON.parse(metaBlock); } catch { /* ignore */ }
          const ids: string[] = parsedMeta._ids || [];

          const searchCards: KnowledgeCard[] = [];
          const entries = textBlock.split(/\n\n/).filter((block: string) => /^\d+\.\s/.test(block.trim()));

          for (let i = 0; i < entries.length; i++) {
            const block = entries[i].trim();
            const headerMatch = block.match(/^\d+\.\s+\[([^\]]*)\]\s+(.*?)(?:\s+\(([^)]+)\))?\s*$/m);
            const summaryLines = block.split('\n').slice(1).map((l: string) => l.trim()).filter(Boolean);
            const title = headerMatch?.[2] || block.split('\n')[0].replace(/^\d+\.\s*/, '');
            const category = headerMatch?.[1] || 'key_point';
            const meta = headerMatch?.[3] || '';

            const scoreMatch = meta.match(/(\d+)%/);
            const daysMatch = meta.match(/(\d+)d\s*ago/);
            const todayMatch = meta.match(/\btoday\b/);
            const tokensMatch = meta.match(/~(\d+)tok/);

            searchCards.push({
              id: ids[i] || `search-${i}`,
              category,
              title,
              summary: summaryLines.join(' ') || title,
              status: 'active',
              confidence: scoreMatch ? parseInt(scoreMatch[1]) / 100 : undefined,
              days_ago: todayMatch ? 0 : daysMatch ? parseInt(daysMatch[1]) : undefined,
              tokens_est: tokensMatch ? parseInt(tokensMatch[1]) : undefined,
              tags: '',
            });
          }

          setSearchResults(searchCards.length > 0 ? searchCards : []);
        }
      } catch {
        setSearchResults([]);
      }
    }
    setSearching(false);
  }, [api, activeTab, searchQuery, setEvents, setEventsTotal]);

  return {
    searchQuery,
    searchResults,
    searching,
    setSearchQuery,
    setSearchResults,
    handleSearch,
  };
}
