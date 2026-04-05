import { useState, useCallback } from 'react';
import { useI18n } from '../lib/i18n';

type LearningStatus = {
  pendingCount: number;
  highPriorityPendingCount: number;
  promotionProposalCount: number;
  readyForPromotionCount: number;
  todayProcessedCount: number;
  todayApprovedCount: number;
  todayRejectedCount: number;
  learningsDir?: string;
};

type LearningFeedback = { kind: 'success' | 'error'; message: string } | null;

type PromotionProposal = {
  id: string;
  status: 'proposed' | 'approved' | 'rejected';
  target: 'AGENTS.md' | 'SOUL.md' | 'TOOLS.md';
  summary: string;
  ruleText: string;
  evidenceCount: number;
  createdAt?: string;
  approvedAt?: string;
  rejectedAt?: string;
};

export type SelfImprovementState = {
  learningStatus: LearningStatus | null;
  learningType: 'learning' | 'error' | 'feature';
  learningSummary: string;
  learningDetails: string;
  learningAction: string;
  learningCategory: 'correction' | 'insight' | 'knowledge_gap' | 'best_practice';
  learningArea: 'frontend' | 'backend' | 'infra' | 'tests' | 'docs' | 'config';
  learningPriority: 'low' | 'medium' | 'high' | 'critical';
  learningSaving: boolean;
  learningFeedback: LearningFeedback;
  promotionProposals: PromotionProposal[];
  promotionLoading: boolean;
  promotionApplyingId: string | null;
  promotionRejectingId: string | null;
  promotionApplyingAll: boolean;

  setLearningType: (v: 'learning' | 'error' | 'feature') => void;
  setLearningSummary: (v: string) => void;
  setLearningDetails: (v: string) => void;
  setLearningAction: (v: string) => void;
  setLearningCategory: (v: 'correction' | 'insight' | 'knowledge_gap' | 'best_practice') => void;
  setLearningArea: (v: 'frontend' | 'backend' | 'infra' | 'tests' | 'docs' | 'config') => void;
  setLearningPriority: (v: 'low' | 'medium' | 'high' | 'critical') => void;

  loadLearningStatus: () => Promise<void>;
  loadPromotionProposals: () => Promise<void>;
  applyPromotionProposal: (proposalId: string) => Promise<void>;
  rejectPromotionProposal: (proposalId: string) => Promise<void>;
  applyAllPromotionProposals: () => Promise<void>;
  submitLearningLog: () => Promise<void>;
};

export function useSelfImprovement(agentId: string): SelfImprovementState {
  const { t } = useI18n();
  const api = window.electronAPI as any;

  const [learningStatus, setLearningStatus] = useState<LearningStatus | null>(null);
  const [learningType, setLearningType] = useState<'learning' | 'error' | 'feature'>('learning');
  const [learningSummary, setLearningSummary] = useState('');
  const [learningDetails, setLearningDetails] = useState('');
  const [learningAction, setLearningAction] = useState('');
  const [learningCategory, setLearningCategory] = useState<'correction' | 'insight' | 'knowledge_gap' | 'best_practice'>('insight');
  const [learningArea, setLearningArea] = useState<'frontend' | 'backend' | 'infra' | 'tests' | 'docs' | 'config'>('docs');
  const [learningPriority, setLearningPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [learningSaving, setLearningSaving] = useState(false);
  const [learningFeedback, setLearningFeedback] = useState<LearningFeedback>(null);
  const [promotionProposals, setPromotionProposals] = useState<PromotionProposal[]>([]);
  const [promotionLoading, setPromotionLoading] = useState(false);
  const [promotionApplyingId, setPromotionApplyingId] = useState<string | null>(null);
  const [promotionRejectingId, setPromotionRejectingId] = useState<string | null>(null);
  const [promotionApplyingAll, setPromotionApplyingAll] = useState(false);

  const loadLearningStatus = useCallback(async () => {
    if (!api?.memoryLearningStatus) return;
    try {
      const status = await api.memoryLearningStatus({ agentId });
      if (status?.success) {
        setLearningStatus({
          pendingCount: Number(status.pendingCount || 0),
          highPriorityPendingCount: Number(status.highPriorityPendingCount || 0),
          promotionProposalCount: Number(status.promotionProposalCount || 0),
          readyForPromotionCount: Number(status.readyForPromotionCount || 0),
          todayProcessedCount: Number(status.todayProcessedCount || 0),
          todayApprovedCount: Number(status.todayApprovedCount || 0),
          todayRejectedCount: Number(status.todayRejectedCount || 0),
          learningsDir: status.learningsDir,
        });
      }
    } catch {
      // keep silent: .learnings is optional and should not break memory page
    }
  }, [api, agentId]);

  const loadPromotionProposals = useCallback(async () => {
    if (!api?.memoryPromotionList) return;
    setPromotionLoading(true);
    try {
      const result = await api.memoryPromotionList({ agentId });
      if (result?.success) {
        const items = Array.isArray(result.items) ? result.items : [];
        setPromotionProposals(items.slice(0, 12));
      }
    } catch {
      // keep silent: proposal file is optional
    } finally {
      setPromotionLoading(false);
    }
  }, [api, agentId]);

  const applyPromotionProposal = useCallback(async (proposalId: string) => {
    if (!api?.memoryPromotionApply || !proposalId) return;
    setPromotionApplyingId(proposalId);
    try {
      const result = await api.memoryPromotionApply({ proposalId, agentId });
      if (result?.success) {
        setLearningFeedback({
          kind: 'success',
          message: `${t('memory.selfImprovement.proposalApplied', 'Applied proposal to target file.')}${result?.proposal?.target ? ` (${result.proposal.target})` : ''}`,
        });
        await Promise.all([loadLearningStatus(), loadPromotionProposals()]);
      } else {
        setLearningFeedback({
          kind: 'error',
          message: result?.error || t('memory.selfImprovement.proposalApplyFailed', 'Failed to apply promotion proposal.'),
        });
      }
    } catch {
      setLearningFeedback({ kind: 'error', message: t('memory.selfImprovement.proposalApplyFailed', 'Failed to apply promotion proposal.') });
    } finally {
      setPromotionApplyingId(null);
    }
  }, [api, agentId, loadLearningStatus, loadPromotionProposals, t]);

  const rejectPromotionProposal = useCallback(async (proposalId: string) => {
    if (!api?.memoryPromotionReject || !proposalId) return;
    setPromotionRejectingId(proposalId);
    try {
      const result = await api.memoryPromotionReject({ proposalId, agentId });
      if (result?.success) {
        setLearningFeedback({
          kind: 'success',
          message: t('memory.selfImprovement.proposalRejected', 'Rejected promotion proposal.'),
        });
        await Promise.all([loadLearningStatus(), loadPromotionProposals()]);
      } else {
        setLearningFeedback({
          kind: 'error',
          message: result?.error || t('memory.selfImprovement.proposalRejectFailed', 'Failed to reject promotion proposal.'),
        });
      }
    } catch {
      setLearningFeedback({ kind: 'error', message: t('memory.selfImprovement.proposalRejectFailed', 'Failed to reject promotion proposal.') });
    } finally {
      setPromotionRejectingId(null);
    }
  }, [api, agentId, loadLearningStatus, loadPromotionProposals, t]);

  const applyAllPromotionProposals = useCallback(async () => {
    if (!api?.memoryPromotionApplyAll) return;
    setPromotionApplyingAll(true);
    try {
      const result = await api.memoryPromotionApplyAll({ agentId });
      if (result?.success) {
        const appliedCount = Number(result?.result?.appliedCount || 0);
        const requestedCount = Number(result?.result?.requestedCount || 0);
        setLearningFeedback({
          kind: 'success',
          message: `${t('memory.selfImprovement.proposalApplyAllDone', 'Applied all proposed entries.')} ${appliedCount}/${requestedCount}`,
        });
        await Promise.all([loadLearningStatus(), loadPromotionProposals()]);
      } else {
        setLearningFeedback({
          kind: 'error',
          message: result?.error || t('memory.selfImprovement.proposalApplyAllFailed', 'Failed to apply all proposals.'),
        });
      }
    } catch {
      setLearningFeedback({ kind: 'error', message: t('memory.selfImprovement.proposalApplyAllFailed', 'Failed to apply all proposals.') });
    } finally {
      setPromotionApplyingAll(false);
    }
  }, [api, agentId, loadLearningStatus, loadPromotionProposals, t]);

  const submitLearningLog = useCallback(async () => {
    if (!api?.memoryLogLearning) return;
    const summary = learningSummary.trim();
    if (!summary) {
      setLearningFeedback({ kind: 'error', message: t('memory.selfImprovement.errorSummaryRequired', 'Please add a short summary first.') });
      return;
    }

    setLearningSaving(true);
    setLearningFeedback(null);
    try {
      const result = await api.memoryLogLearning({
        type: learningType,
        summary,
        details: learningDetails.trim() || undefined,
        suggestedAction: learningAction.trim() || undefined,
        category: learningType === 'learning' ? learningCategory : undefined,
        area: learningArea,
        priority: learningPriority,
        commandName: learningType === 'error' ? 'desktop_chat' : undefined,
        source: 'desktop',
        complexity: learningType === 'feature' ? 'medium' : undefined,
        userContext: learningType === 'feature' ? learningDetails.trim() || undefined : undefined,
        frequency: learningType === 'feature' ? 'first_time' : undefined,
        agentId,
      });

      if (result?.success) {
        const generatedPromotions = Number(result?.promotion?.generatedCount || 0);
        setLearningSummary('');
        setLearningDetails('');
        setLearningAction('');
        setLearningFeedback({
          kind: 'success',
          message: generatedPromotions > 0
            ? `${t('memory.selfImprovement.saved', 'Saved to .learnings successfully.')} ${t('memory.selfImprovement.promotionGenerated', 'Generated promotion proposals:')} ${generatedPromotions}`
            : t('memory.selfImprovement.saved', 'Saved to .learnings successfully.'),
        });
        await Promise.all([loadLearningStatus(), loadPromotionProposals()]);
      } else {
        setLearningFeedback({
          kind: 'error',
          message: result?.error || t('memory.selfImprovement.saveFailed', 'Failed to save this learning entry.'),
        });
      }
    } catch {
      setLearningFeedback({ kind: 'error', message: t('memory.selfImprovement.saveFailed', 'Failed to save this learning entry.') });
    } finally {
      setLearningSaving(false);
    }
  }, [api, agentId, learningAction, learningArea, learningCategory, learningDetails, learningPriority, learningSummary, learningType, loadLearningStatus, loadPromotionProposals, t]);

  return {
    learningStatus, learningType, learningSummary, learningDetails, learningAction,
    learningCategory, learningArea, learningPriority, learningSaving, learningFeedback,
    promotionProposals, promotionLoading, promotionApplyingId, promotionRejectingId, promotionApplyingAll,
    setLearningType, setLearningSummary, setLearningDetails, setLearningAction,
    setLearningCategory, setLearningArea, setLearningPriority,
    loadLearningStatus, loadPromotionProposals,
    applyPromotionProposal, rejectPromotionProposal, applyAllPromotionProposals,
    submitLearningLog,
  };
}
