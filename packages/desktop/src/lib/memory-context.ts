export interface MemoryKnowledgeCard {
  id: string;
  category: string;
  title: string;
  summary: string;
  created_at?: string;
  status?: string;
  confidence?: number;
  tokens_est?: number;
  days_ago?: number;
  tags?: string;
  // F-031 Phase 1 personal-wiki fields (all optional for back-compat).
  question_this_answers?: string | null;
  body?: string | null;
  body_format?: "markdown" | "text" | string | null;
  growth_stage?: "seedling" | "budding" | "evergreen" | string | null;
  card_type?: "atomic" | "moc" | string | null;
  link_count_incoming?: number | null;
  link_count_outgoing?: number | null;
  language?: string | null;
  last_touched_at?: string | null;
}

export interface ParsedMemoryContext {
  cards: MemoryKnowledgeCard[];
  openTasks: number;
  errorKey?: string;
  hasStructuredContext: boolean;
}

function normalizeCard(card: any): MemoryKnowledgeCard | null {
  if (!card || typeof card !== 'object') return null;
  const title = typeof card.title === 'string' ? card.title : '';
  const summary = typeof card.summary === 'string' ? card.summary : '';
  if (!title && !summary) return null;
  return {
    id: String(card.id || title || summary),
    category: String(card.category || 'key_point'),
    title,
    summary,
    created_at: typeof card.created_at === 'string' ? card.created_at : undefined,
    status: typeof card.status === 'string' ? card.status : undefined,
  };
}

export function parseMemoryContextResponse(result: any): ParsedMemoryContext {
  if (result?.error) {
    return {
      cards: [],
      openTasks: 0,
      errorKey: 'memory.serviceDisconnected',
      hasStructuredContext: false,
    };
  }

  const text = result?.result?.content?.[0]?.text;
  if (!text) {
    return {
      cards: [],
      openTasks: 0,
      errorKey: 'memory.emptyResponse',
      hasStructuredContext: false,
    };
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed?.error) {
      return {
        cards: [],
        openTasks: 0,
        errorKey: 'memory.serviceDisconnected',
        hasStructuredContext: false,
      };
    }

    const cards = Array.isArray(parsed?.knowledge_cards)
      ? parsed.knowledge_cards.map(normalizeCard).filter(Boolean)
      : [];
    const openTasks = Array.isArray(parsed?.open_tasks) ? parsed.open_tasks.length : 0;

    return {
      cards,
      openTasks,
      hasStructuredContext: cards.length > 0 || openTasks > 0,
    };
  } catch {
    return {
      cards: [],
      openTasks: 0,
      errorKey: 'memory.parseFailed',
      hasStructuredContext: false,
    };
  }
}