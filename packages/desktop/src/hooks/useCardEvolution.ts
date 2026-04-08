import { useState, useCallback } from 'react';

export interface CardEvolutionState {
  expandedCard: string | null;
  cardEvolution: any[] | null;
  evolutionLoading: boolean;
}

export interface CardEvolutionActions {
  toggleCardExpand: (cardId: string) => void;
}

export type UseCardEvolutionReturn = CardEvolutionState & CardEvolutionActions;

/**
 * Manages card detail expansion and evolution chain loading.
 * Extracted from Memory.tsx to reduce file size.
 */
export function useCardEvolution(api: any): UseCardEvolutionReturn {
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [cardEvolution, setCardEvolution] = useState<any[] | null>(null);
  const [evolutionLoading, setEvolutionLoading] = useState(false);

  const loadEvolution = useCallback(async (cardId: string) => {
    if (!api) return;
    setEvolutionLoading(true);
    try {
      const result = await api.memoryGetCardEvolution(cardId);
      setCardEvolution(Array.isArray(result?.chain) ? result.chain : Array.isArray(result) ? result : []);
    } catch {
      setCardEvolution([]);
    } finally {
      setEvolutionLoading(false);
    }
  }, [api]);

  const toggleCardExpand = useCallback((cardId: string) => {
    if (expandedCard === cardId) {
      setExpandedCard(null);
      setCardEvolution(null);
    } else {
      setExpandedCard(cardId);
      loadEvolution(cardId);
    }
  }, [expandedCard, loadEvolution]);

  return {
    expandedCard,
    cardEvolution,
    evolutionLoading,
    toggleCardExpand,
  };
}
