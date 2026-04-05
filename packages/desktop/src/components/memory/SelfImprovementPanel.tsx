import { Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '../../lib/i18n';
import type { SelfImprovementState } from '../../hooks/useSelfImprovement';

type SelfImprovementPanelProps = SelfImprovementState;

export function SelfImprovementPanel(props: SelfImprovementPanelProps) {
  const { t } = useI18n();
  const {
    learningStatus, learningType, learningSummary, learningDetails, learningAction,
    learningCategory, learningArea, learningPriority, learningSaving, learningFeedback,
    promotionProposals, promotionLoading, promotionApplyingId, promotionRejectingId, promotionApplyingAll,
    setLearningType, setLearningSummary, setLearningDetails, setLearningAction,
    setLearningCategory, setLearningArea, setLearningPriority,
    loadPromotionProposals, applyPromotionProposal, rejectPromotionProposal,
    applyAllPromotionProposals, submitLearningLog,
  } = props;

  return (
    <section className="rounded-[24px] border border-slate-700/60 bg-slate-900/55 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-slate-500">{t('memory.selfImprovement.badge', 'Self Improvement')}</div>
          <h3 className="mt-2 text-base font-semibold text-slate-100">{t('memory.selfImprovement.title', 'Capture Learnings, Errors, and Feature Requests')}</h3>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
            {t('memory.selfImprovement.desc', 'Official self-improving-agent workflow writes structured entries into .learnings so patterns can be promoted into AGENTS.md, SOUL.md, and TOOLS.md later.')}
          </p>
        </div>
        <div className="grid min-w-[300px] gap-2 sm:grid-cols-4">
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('memory.selfImprovement.pending', 'Pending')}</div>
            <div className="mt-1 text-sm font-medium text-slate-100">{learningStatus?.pendingCount ?? 0}</div>
          </div>
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('memory.selfImprovement.highPriority', 'High Priority')}</div>
            <div className="mt-1 text-sm font-medium text-amber-300">{learningStatus?.highPriorityPendingCount ?? 0}</div>
          </div>
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('memory.selfImprovement.proposals', 'Promotion Proposals')}</div>
            <div className="mt-1 text-sm font-medium text-cyan-300">{learningStatus?.promotionProposalCount ?? 0}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              {t('memory.selfImprovement.ready', 'Ready')}: {learningStatus?.readyForPromotionCount ?? 0}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-700/70 bg-slate-950/70 px-4 py-3">
            <div className="text-[11px] uppercase tracking-[0.16em] text-slate-500">{t('memory.selfImprovement.todayProcessed', 'Today Processed')}</div>
            <div className="mt-1 text-sm font-medium text-emerald-300">{learningStatus?.todayProcessedCount ?? 0}</div>
            <div className="mt-1 text-[11px] text-slate-500">
              A {learningStatus?.todayApprovedCount ?? 0} / R {learningStatus?.todayRejectedCount ?? 0}
            </div>
          </div>
        </div>
      </div>

      {/* Form: Type / Area / Priority */}
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <label className="space-y-1 text-xs text-slate-400">
          <span>{t('memory.selfImprovement.type', 'Type')}</span>
          <select
            value={learningType}
            onChange={(event) => setLearningType(event.target.value as 'learning' | 'error' | 'feature')}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
          >
            <option value="learning">{t('memory.selfImprovement.type.learning', 'Learning')}</option>
            <option value="error">{t('memory.selfImprovement.type.error', 'Error')}</option>
            <option value="feature">{t('memory.selfImprovement.type.feature', 'Feature Request')}</option>
          </select>
        </label>

        <label className="space-y-1 text-xs text-slate-400">
          <span>{t('memory.selfImprovement.area', 'Area')}</span>
          <select
            value={learningArea}
            onChange={(event) => setLearningArea(event.target.value as 'frontend' | 'backend' | 'infra' | 'tests' | 'docs' | 'config')}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
          >
            {['frontend', 'backend', 'infra', 'tests', 'docs', 'config'].map((area) => (
              <option key={area} value={area}>{area}</option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs text-slate-400">
          <span>{t('memory.selfImprovement.priority', 'Priority')}</span>
          <select
            value={learningPriority}
            onChange={(event) => setLearningPriority(event.target.value as 'low' | 'medium' | 'high' | 'critical')}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
          >
            {['low', 'medium', 'high', 'critical'].map((priority) => (
              <option key={priority} value={priority}>{priority}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Conditional: Category (only for learnings) */}
      {learningType === 'learning' && (
        <label className="mt-3 block space-y-1 text-xs text-slate-400">
          <span>{t('memory.selfImprovement.category', 'Category')}</span>
          <select
            value={learningCategory}
            onChange={(event) => setLearningCategory(event.target.value as 'correction' | 'insight' | 'knowledge_gap' | 'best_practice')}
            className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 focus:border-brand-500 focus:outline-none"
          >
            <option value="correction">correction</option>
            <option value="insight">insight</option>
            <option value="knowledge_gap">knowledge_gap</option>
            <option value="best_practice">best_practice</option>
          </select>
        </label>
      )}

      {/* Text inputs */}
      <label className="mt-3 block space-y-1 text-xs text-slate-400">
        <span>{t('memory.selfImprovement.summary', 'Summary')}</span>
        <input
          value={learningSummary}
          onChange={(event) => setLearningSummary(event.target.value)}
          placeholder={t('memory.selfImprovement.summaryPlaceholder', 'One-line description of what happened')}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-brand-500 focus:outline-none"
        />
      </label>

      <label className="mt-3 block space-y-1 text-xs text-slate-400">
        <span>{t('memory.selfImprovement.details', 'Details')}</span>
        <textarea
          value={learningDetails}
          onChange={(event) => setLearningDetails(event.target.value)}
          rows={3}
          placeholder={t('memory.selfImprovement.detailsPlaceholder', 'Include context, what was wrong, and what changed.')}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-brand-500 focus:outline-none"
        />
      </label>

      <label className="mt-3 block space-y-1 text-xs text-slate-400">
        <span>{t('memory.selfImprovement.action', 'Suggested Action')}</span>
        <textarea
          value={learningAction}
          onChange={(event) => setLearningAction(event.target.value)}
          rows={2}
          placeholder={t('memory.selfImprovement.actionPlaceholder', 'What should we do differently next time?')}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-500 focus:border-brand-500 focus:outline-none"
        />
      </label>

      {/* Submit */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-slate-500">
          {learningStatus?.learningsDir
            ? `${t('memory.selfImprovement.location', 'Writing to')}: ${learningStatus.learningsDir}`
            : t('memory.selfImprovement.locationUnknown', 'The .learnings directory will be created automatically.')}
          <div className="mt-1 text-[11px] text-slate-600">
            {t('memory.selfImprovement.promotionRule', 'Auto-proposal rule: recurring pattern >= 3 entries in the recent 30-day window.')}
          </div>
        </div>
        <button
          onClick={() => { void submitLearningLog(); }}
          disabled={learningSaving}
          className="inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {learningSaving ? <Loader2 size={12} className="animate-spin" /> : null}
          {learningSaving
            ? t('memory.selfImprovement.saving', 'Saving...')
            : t('memory.selfImprovement.save', 'Save Entry')}
        </button>
      </div>

      {/* Feedback */}
      {learningFeedback && (
        <div className={`mt-3 rounded-xl border px-3 py-2 text-xs ${
          learningFeedback.kind === 'success'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : 'border-red-500/40 bg-red-500/10 text-red-200'
        }`}>
          {learningFeedback.message}
        </div>
      )}

      {/* Promotion Queue */}
      <div className="mt-5 rounded-2xl border border-slate-700/70 bg-slate-950/50 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-slate-500">{t('memory.selfImprovement.proposalQueue', 'Promotion Queue')}</div>
            <div className="mt-1 text-[11px] text-slate-500">{t('memory.selfImprovement.proposalQueueDesc', 'Approve proposals to write rules into AGENTS.md, SOUL.md, or TOOLS.md.')}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { void applyAllPromotionProposals(); }}
              disabled={promotionLoading || promotionApplyingAll || !promotionProposals.some((item) => item.status === 'proposed')}
              className="inline-flex items-center gap-1 rounded-lg border border-cyan-600/60 px-2.5 py-1 text-[11px] text-cyan-300 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {promotionApplyingAll ? <Loader2 size={11} className="animate-spin" /> : null}
              {promotionApplyingAll
                ? t('memory.selfImprovement.proposalApplyingAll', 'Applying all...')
                : t('memory.selfImprovement.proposalApplyAll', 'Apply All Proposed')}
            </button>
            <button
              onClick={() => { void loadPromotionProposals(); }}
              disabled={promotionLoading || promotionApplyingAll}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {promotionLoading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              {t('common.refresh', 'Refresh')}
            </button>
          </div>
        </div>

        {promotionProposals.length === 0 ? (
          <div className="mt-3 text-xs text-slate-500">{t('memory.selfImprovement.proposalEmpty', 'No promotion proposals yet.')}</div>
        ) : (
          <div className="mt-3 space-y-2">
            {promotionProposals.map((proposal) => (
              <div key={proposal.id} className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-slate-100">{proposal.id}</div>
                    <div className="mt-1 text-[11px] text-slate-400">{proposal.summary || proposal.ruleText}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-cyan-300">{proposal.target}</div>
                    <div className="text-[11px] text-slate-500">{t('memory.selfImprovement.status', 'Status')}: {proposal.status}</div>
                  </div>
                </div>
                {proposal.status === 'proposed' && (
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      onClick={() => { void rejectPromotionProposal(proposal.id); }}
                      disabled={promotionRejectingId === proposal.id || promotionApplyingId === proposal.id || promotionApplyingAll}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/50 px-3 py-1.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {promotionRejectingId === proposal.id ? <Loader2 size={11} className="animate-spin" /> : null}
                      {promotionRejectingId === proposal.id
                        ? t('memory.selfImprovement.proposalRejecting', 'Rejecting...')
                        : t('memory.selfImprovement.proposalReject', 'Reject')}
                    </button>
                    <button
                      onClick={() => { void applyPromotionProposal(proposal.id); }}
                      disabled={promotionApplyingId === proposal.id || promotionRejectingId === proposal.id || promotionApplyingAll}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {promotionApplyingId === proposal.id ? <Loader2 size={11} className="animate-spin" /> : null}
                      {promotionApplyingId === proposal.id
                        ? t('memory.selfImprovement.proposalApplying', 'Applying...')
                        : t('memory.selfImprovement.proposalApply', 'Apply to Target')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
