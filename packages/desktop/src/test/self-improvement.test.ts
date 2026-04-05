import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      _allowedRoots: [workspacePath],
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

    const status = await getSelfImprovementStatus({ workspacePath, _allowedRoots: [workspacePath] });
    expect(status.promotionProposalCount).toBe(1);
    expect(status.readyForPromotionCount).toBe(1);
  });

  it('keeps proposal generation idempotent for the same recurring pattern key', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      _allowedRoots: [workspacePath],
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
      _allowedRoots: [workspacePath],
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);

    const beforeApply = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(beforeApply.items.length).toBe(1);
    expect(beforeApply.items[0].status).toBe('proposed');

    const applied = await applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId: beforeApply.items[0].id,
    });

    expect(applied.proposal.status).toBe('approved');
    expect(applied.proposal.target).toBe('TOOLS.md');

    const toolsPath = path.join(workspacePath, 'TOOLS.md');
    const toolsContent = await fs.promises.readFile(toolsPath, 'utf8');
    expect(toolsContent).toContain(`promotion: ${beforeApply.items[0].id}`);
    expect(toolsContent).toContain('Auto-promoted Rule');

    const afterApply = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(afterApply.items[0].status).toBe('approved');

    const status = await getSelfImprovementStatus({ workspacePath, _allowedRoots: [workspacePath] });
    expect(status.promotionProposalCount).toBe(1);
    expect(status.readyForPromotionCount).toBe(0);

    await applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
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
      _allowedRoots: [workspacePath],
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);

    const listed = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].status).toBe('proposed');

    const rejected = await rejectSelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId: listed.items[0].id,
    });
    expect(rejected.proposal.status).toBe('rejected');

    const afterReject = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(afterReject.items[0].status).toBe('rejected');

    const status = await getSelfImprovementStatus({ workspacePath, _allowedRoots: [workspacePath] });
    expect(status.readyForPromotionCount).toBe(0);
  });

  it('applies all remaining proposed proposals in bulk', async () => {
    const payloadOne = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      _allowedRoots: [workspacePath],
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };
    const payloadTwo = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      _allowedRoots: [workspacePath],
      summary: 'Use a consistent concise communication style across responses',
    };

    for (let i = 0; i < 3; i += 1) {
      await appendSelfImprovementEntry(payloadOne);
      await appendSelfImprovementEntry(payloadTwo);
    }

    const before = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(before.items).toHaveLength(2);

    await applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId: before.items[0].id,
    });

    const bulk = await applyAllSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(bulk.result.requestedCount).toBe(1);
    expect(bulk.result.appliedCount).toBe(1);
    expect(bulk.result.skippedCount).toBe(1);

    const after = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    expect(after.items.every((item) => item.status === 'approved')).toBe(true);
  });

  it('replaces an existing TOOLS auto-promoted block when pattern key matches', async () => {
    const learningsDir = path.join(workspacePath, '.learnings');
    await fs.promises.mkdir(learningsDir, { recursive: true });

    const proposalsPath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');
    await fs.promises.writeFile(proposalsPath, [
      '# Promotion Proposals',
      '',
      '## [PROMO-20260405-001] TOOLS.md',
      '',
      '**Created**: 2026-04-05T09:00:00.000Z',
      '**Status**: approved',
      '**Pattern-Key**: learning|docs|verify openclaw cli flags before changing chat command arguments',
      '**Target**: `TOOLS.md`',
      '**Evidence Count**: 3',
      '**Evidence IDs**: LRN-20260405-001, LRN-20260405-002, LRN-20260405-003',
      '**Window**: 30 days',
      '**Trigger**: recurrence >= 3',
      '',
      '### Pattern Summary',
      'Verify OpenClaw CLI flags before changing chat command arguments',
      '',
      '### Proposed Rule',
      'Old rule text.',
      '',
      '---',
      '',
      '## [PROMO-20260405-002] TOOLS.md',
      '',
      '**Created**: 2026-04-05T10:00:00.000Z',
      '**Status**: proposed',
      '**Pattern-Key**: learning|docs|verify openclaw cli flags before changing chat command arguments',
      '**Target**: `TOOLS.md`',
      '**Evidence Count**: 4',
      '**Evidence IDs**: LRN-20260405-001, LRN-20260405-002, LRN-20260405-003, LRN-20260405-004',
      '**Window**: 30 days',
      '**Trigger**: recurrence >= 3',
      '',
      '### Pattern Summary',
      'Verify OpenClaw CLI flags before changing chat command arguments',
      '',
      '### Proposed Rule',
      'Newer rule text.',
      '',
      '---',
      '',
    ].join('\n'), 'utf8');

    const toolsPath = path.join(workspacePath, 'TOOLS.md');
    await fs.promises.writeFile(toolsPath, [
      '# TOOLS',
      '',
      'Tool usage rules and operational safeguards.',
      '',
      '<!-- promotion: PROMO-20260405-001 -->',
      '### [PROMO-20260405-001] Auto-promoted Rule',
      '- Pattern-Key: learning|docs|verify openclaw cli flags before changing chat command arguments',
      '- Pattern: Verify OpenClaw CLI flags before changing chat command arguments',
      '- Rule: Old rule text.',
      '- Evidence: LRN-20260405-001, LRN-20260405-002, LRN-20260405-003',
      '- Applied: 2026-04-05T09:00:00.000Z',
      '',
    ].join('\n'), 'utf8');

    const applied = await applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId: 'PROMO-20260405-002',
    });

    expect(applied.proposal.status).toBe('approved');
    const toolsContent = await fs.promises.readFile(toolsPath, 'utf8');
    expect(toolsContent).toContain('promotion: PROMO-20260405-002');
    expect(toolsContent).not.toContain('promotion: PROMO-20260405-001');
    expect(toolsContent).toContain('- Rule: Newer rule text.');
  });

  it('dedupes AGENTS rules when an equivalent auto-promoted rule already exists', async () => {
    const learningsDir = path.join(workspacePath, '.learnings');
    await fs.promises.mkdir(learningsDir, { recursive: true });

    const proposalsPath = path.join(learningsDir, 'PROMOTION_PROPOSALS.md');
    await fs.promises.writeFile(proposalsPath, [
      '# Promotion Proposals',
      '',
      '## [PROMO-20260405-101] AGENTS.md',
      '',
      '**Created**: 2026-04-05T10:00:00.000Z',
      '**Status**: proposed',
      '**Pattern-Key**: learning|docs|standardize workflow for recurring setup steps',
      '**Target**: `AGENTS.md`',
      '**Evidence Count**: 3',
      '**Evidence IDs**: LRN-20260405-011, LRN-20260405-012, LRN-20260405-013',
      '**Window**: 30 days',
      '**Trigger**: recurrence >= 3',
      '',
      '### Pattern Summary',
      'Standardize workflow for recurring setup steps',
      '',
      '### Proposed Rule',
      'Standardize a repeatable workflow for setup steps.',
      '',
      '---',
      '',
    ].join('\n'), 'utf8');

    const agentsPath = path.join(workspacePath, 'AGENTS.md');
    await fs.promises.writeFile(agentsPath, [
      '# AGENTS',
      '',
      'Workflow rules and coordination guidelines.',
      '',
      '<!-- promotion: PROMO-20260404-999 -->',
      '### [PROMO-20260404-999] Auto-promoted Rule',
      '- Pattern-Key: learning|docs|legacy key',
      '- Pattern: Some older summary',
      '- Rule: Standardize a repeatable workflow for setup steps.',
      '- Evidence: LRN-20260404-001, LRN-20260404-002, LRN-20260404-003',
      '- Applied: 2026-04-04T10:00:00.000Z',
      '',
    ].join('\n'), 'utf8');

    const applied = await applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId: 'PROMO-20260405-101',
    });

    expect(applied.proposal.status).toBe('approved');
    const agentsContent = await fs.promises.readFile(agentsPath, 'utf8');
    expect(agentsContent).toContain('promotion: PROMO-20260404-999');
    expect(agentsContent).not.toContain('promotion: PROMO-20260405-101');
  });

  it('rolls back target file changes when proposal status write fails', async () => {
    const payload = {
      type: 'learning' as const,
      area: 'docs' as const,
      source: 'desktop',
      workspacePath,
      _allowedRoots: [workspacePath],
      summary: 'Verify OpenClaw CLI flags before changing chat command arguments',
    };

    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);
    await appendSelfImprovementEntry(payload);

    const listed = await listSelfImprovementPromotionProposals({ workspacePath, _allowedRoots: [workspacePath] });
    const proposalId = listed.items[0].id;
    const proposalsPath = path.join(workspacePath, '.learnings', 'PROMOTION_PROPOSALS.md');
    const toolsPath = path.join(workspacePath, 'TOOLS.md');

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const writeSpy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (filePath: any, data: any, options?: any) => {
      const normalizedPath = String(filePath).replace(/\\/g, '/');
      if (normalizedPath.endsWith('/.learnings/PROMOTION_PROPOSALS.md')) {
        throw new Error('forced proposal write failure');
      }
      return originalWriteFile(filePath, data, options as any);
    });

    await expect(applySelfImprovementPromotionProposal({
      workspacePath,
      _allowedRoots: [workspacePath],
      proposalId,
    })).rejects.toThrow('Failed to apply promotion proposal');

    writeSpy.mockRestore();

    const toolsContent = await fs.promises.readFile(toolsPath, 'utf8');
    expect(toolsContent).not.toContain(`promotion: ${proposalId}`);

    const proposalsContent = await fs.promises.readFile(proposalsPath, 'utf8');
    expect(proposalsContent).toContain('**Status**: proposed');
  });
});
