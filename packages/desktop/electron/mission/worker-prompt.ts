/**
 * Worker prompt builder — used for each subtask step spawn.
 *
 * Composition (matches 01-DESIGN.md §5.2 "Worker Prompt"):
 *   <MissionGoal> + <YourRole> + <PreviousArtifacts> + <SharedMemory>
 *   + <PastExperience> + <YourTask> + <HandoffInstructions>
 *
 * The WORKER agent is a sub-agent spawned via Gateway sessions_spawn. Its
 * output markdown MUST end with a "## Handoff to next agent" section so the
 * next step can continue without re-reading the world.
 */

import type { Mission, MissionStep } from './types';

export interface BuildWorkerPromptInput {
  readonly mission: Pick<Mission, 'id' | 'goal' | 'rootWorkDir'>;
  readonly step: MissionStep;
  readonly previousArtifacts: readonly { readonly stepId: string; readonly title: string; readonly content: string }[];
  readonly sharedMemory: string;       // MEMORY.md contents
  readonly pastExperience?: string;    // Awareness recall — S3 will populate
}

export function buildWorkerPrompt(input: BuildWorkerPromptInput): string {
  const { mission, step, previousArtifacts, sharedMemory, pastExperience } = input;

  const prevBlock = previousArtifacts.length === 0
    ? '(none — you are the first step)'
    : previousArtifacts
        .map((a) => `--- ${a.stepId}: ${a.title} ---\n${a.content.trim()}`)
        .join('\n\n');

  const memoryBlock = sharedMemory.trim().length > 0
    ? sharedMemory.trim()
    : '(empty — you are the first to write here)';

  const pastBlock = (pastExperience && pastExperience.trim().length > 0)
    ? pastExperience.trim()
    : '(no prior experience available)';

  const workDirLine = mission.rootWorkDir
    ? `\nWorking directory: ${mission.rootWorkDir}\n`
    : '';

  return [
    '<MissionGoal>',
    mission.goal,
    '</MissionGoal>',
    '',
    '<YourRole>',
    step.role,
    '</YourRole>',
    '',
    '<PreviousArtifacts>',
    prevBlock,
    '</PreviousArtifacts>',
    '',
    '<SharedMemory>',
    memoryBlock,
    '</SharedMemory>',
    '',
    '<PastExperience>',
    pastBlock,
    '</PastExperience>',
    '',
    '<YourTask>',
    `${step.title}`,
    '',
    `Deliverable: ${step.deliverable}`,
    workDirLine,
    '</YourTask>',
    '',
    '<HandoffInstructions>',
    'When you finish, output a single Markdown document with these sections:',
    '  ## What I did',
    '  ## Key files (paths created or modified)',
    '  ## Handoff to next agent',
    '    - Decisions made (do not revisit)',
    '    - Files / paths the next agent needs to know about',
    '    - Known issues / gotchas',
    '    - Next recommended action',
    '',
    'The final message of your session is captured verbatim as the deliverable.',
    '</HandoffInstructions>',
  ].join('\n');
}
