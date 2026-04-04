import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAllSelfImprovementPromotionProposals,
  appendSelfImprovementEntry,
  applySelfImprovementPromotionProposal,
  getSelfImprovementStatus,
  listSelfImprovementPromotionProposals,
  rejectSelfImprovementPromotionProposal,
} from '../../electron/self-improvement';

describe('self-improvement promotion proposals', () => {
  let workspacePath = '';

  beforeEach(async () => {
    workspacePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ac-self-improvement-'));
  });

  afterEach(async () => {
    if (!workspacePath) return;
    await fs.promises.rm(workspacePath, { recursive: true, force: true });
  });

  it('creates one promotion proposal when a recurring pattern reaches threshold', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    const third = await appendSelfImprovementEntry(payload);

    expect(third.promotion.generatedCount).toBe(1);

    const proposalsPath = path.join(workspacePath, '.learnings', 'PROMOTION_PROPOSALS.md');
    const proposals = await fs.promises.readFile(proposalsPath, 'utf8');

    expect(proposals).toContain('## [PROMO-');
    expect(proposals).toContain('**Trigger**: recurrence >= 3');
    expect(proposals).toContain('Verify OpenClaw CLI flags before changing chat command arguments');
    expect(proposals).toContain('`TOOLS.md`');

    const status = await getSelfImprovementStatus({ workspacePath });
    expect(status.promotionProposalCount).toBe(1);
    expect(status.readyForPromotionCount).toBe(1);
  });

  it('keeps proposal generation idempotent for the same recurring pattern key', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    const fourth = await appendSelfImprovementEntry(payload);

    expect(fourth.promotion.generatedCount).toBe(0);

    const proposalsPath = path.join(workspacePath, '.learnings', 'PROMOTION_PROPOSALS.md');
    const proposals = await fs.promises.readFile(proposalsPath, 'utf8');
    const proposalIds = proposals.match(/^## \[PROMO-\d{8}-\d{3}\]/gm) || [];

    expect(proposalIds).toHaveLength(1);
  });

  it('applies a proposal into its target file and marks proposal as approved', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);

    const beforeApply = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(beforeApply.items.length).toBe(1);
    expect(beforeApply.items[0].status).toBe('proposed');

    const applied = await applySelfImprovementPromotionProposal({
      workspacePath,
      proposalId: beforeApply.items[0].id,
    });

    expect(applied.proposal.status).toBe('approved');
    expect(applied.proposal.target).toBe('TOOLS.md');

    const toolsPath = path.join(workspacePath, 'TOOLS.md');
    const toolsContent = await fs.promises.readFile(toolsPath, 'utf8');
    expect(toolsContent).toContain(`promotion: ${beforeApply.items[0].id}`);
    expect(toolsContent).toContain('Auto-promoted Rule');

    const afterApply = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(afterApply.items[0].status).toBe('approved');

    const status = await getSelfImprovementStatus({ workspacePath });
    expect(status.promotionProposalCount).toBe(1);
    expect(status.readyForPromotionCount).toBe(0);

    await applySelfImprovementPromotionProposal({
      workspacePath,
      proposalId: beforeApply.items[0].id,
    });

    const toolsContentAfterSecondApply = await fs.promises.readFile(toolsPath, 'utf8');
    const markerCount = (toolsContentAfterSecondApply.match(new RegExp(`promotion: ${beforeApply.items[0].id}`, 'g')) || []).length;
    expect(markerCount).toBe(1);
  });

  it('rejects a proposal and marks it as rejected', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);

    const listed = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].status).toBe('proposed');

    const rejected = await rejectSelfImprovementPromotionProposal({
      workspacePath,
      proposalId: listed.items[0].id,
    });
    expect(rejected.proposal.status).toBe('rejected');

    const afterReject = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(afterReject.items[0].status).toBe('rejected');

    const status = await getSelfImprovementStatus({ workspacePath });
    expect(status.readyForPromotionCount).toBe(0);
  });

  it('applies all remaining proposed proposals in bulk', async () => {
    const payloadOne = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };
    const payloadTwo = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      summary: 'Use a consistent concise communication style across responses',
    };

    for (let i = 0; i < 3; i += 1) {
      await appendSelfImprovementEntry(payloadOne);
      await appendSelfImprovementEntry(payloadTwo);
    }

    const before = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(before.items).toHaveLength(2);

    await applySelfImprovementPromotionProposal({
      workspacePath,
      proposalId: before.items[0].id,
    });

    const bulk = await applyAllSelfImprovementPromotionProposals({ workspacePath });
    expect(bulk.result.requestedCount).toBe(1);
    expect(bulk.result.appliedCount).toBe(1);
    expect(bulk.result.skippedCount).toBe(1);

    const after = await listSelfImprovementPromotionProposals({ workspacePath });
    expect(after.items.every((item) => item.status === 'approved')).toBe(true);
  });
});
