import { ipcMain } from 'electron';
import { parseJsonShellOutput } from '../openclaw-shell-output';
import { dedupedCronList } from '../openclaw-process-guard';

type CronAddInput = {
  name?: string;
  description?: string;
  cron?: string;
  message?: string;
  systemEvent?: string;
  sessionTarget?: 'main' | 'isolated' | 'current' | `session:${string}`;
  wakeMode?: 'now' | 'next-heartbeat';
  timeoutSeconds?: number;
  announce?: boolean;
  disabled?: boolean;
};

const CRON_LIST_TIMEOUT_MS = 20_000;
const CRON_MUTATION_TIMEOUT_MS = 45_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeCronAddInput(input: unknown, legacyCommand?: unknown): CronAddInput | null {
  if (typeof input === 'string') {
    const cron = input.trim();
    const message = readTrimmedString(legacyCommand);
    if (!cron || !message) return null;
    return {
      cron,
      message,
      sessionTarget: 'isolated',
      timeoutSeconds: 120,
      announce: true,
    };
  }

  if (!isRecord(input)) return null;

  const cron = readTrimmedString(input.cron) ?? readTrimmedString(input.expression);
  const message = readTrimmedString(input.message) ?? readTrimmedString(input.command);
  const systemEvent = readTrimmedString(input.systemEvent);

  if (!cron || (!message && !systemEvent)) {
    return null;
  }

  const sessionTarget = readTrimmedString(input.sessionTarget);
  const wakeMode = readTrimmedString(input.wakeMode);
  const timeoutSeconds = readPositiveInteger(input.timeoutSeconds);
  const resolvedSessionTarget = (sessionTarget as CronAddInput['sessionTarget'] | undefined) ?? (systemEvent ? 'main' : 'isolated');
  const resolvedAnnounce = typeof input.announce === 'boolean' ? input.announce : resolvedSessionTarget === 'isolated';

  return {
    name: readTrimmedString(input.name),
    description: readTrimmedString(input.description),
    cron,
    message,
    systemEvent,
    sessionTarget: resolvedSessionTarget,
    wakeMode: (wakeMode as CronAddInput['wakeMode'] | undefined) ?? (systemEvent ? 'now' : undefined),
    timeoutSeconds: timeoutSeconds ?? (systemEvent ? undefined : 120),
    announce: resolvedAnnounce,
    disabled: input.disabled === true,
  };
}

function deriveJobName(input: CronAddInput): string {
  if (input.name) return input.name;

  const seed = input.systemEvent ?? input.message ?? 'Scheduled task';
  return seed.length > 48 ? `${seed.slice(0, 45)}...` : seed;
}

function buildModernCronAddArgs(input: CronAddInput): string[] {
  const args = ['cron', 'add', '--name', deriveJobName(input), '--cron', input.cron || '', '--json'];

  if (input.description) {
    args.push('--description', input.description);
  }

  if (input.disabled) {
    args.push('--disabled');
  }

  if (input.sessionTarget) {
    args.push('--session', input.sessionTarget);
  }

  if (input.wakeMode) {
    args.push('--wake', input.wakeMode);
  }

  if (input.timeoutSeconds) {
    args.push('--timeout-seconds', String(input.timeoutSeconds));
  }

  if (input.systemEvent) {
    args.push('--system-event', input.systemEvent);
  } else if (input.message) {
    args.push('--message', input.message);
    args.push(input.announce ? '--announce' : '--no-deliver');
  }

  return args;
}

function buildLegacyCronAddArgs(input: CronAddInput): string[] | null {
  const cron = input.cron;
  const text = input.message ?? input.systemEvent;
  if (!cron || !text) return null;
  return ['cron', 'add', cron, text];
}

function canFallbackToLegacy(errorText: string) {
  return /unknown option|unknown command|unexpected argument|too many arguments/i.test(errorText);
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message.replace(/^error:\s*/i, '').trim();
  }
  return String(error);
}

function parsePlainCronLines(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, all) => !(all.length === 1 && /^No cron jobs\.?$/i.test(line)));
}

export function registerCronHandlers(deps: {
  readShellOutputAsync: (cmd: string, timeoutMs?: number) => Promise<string | null>;
  runSpawnAsync: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>;
}) {
  ipcMain.handle('cron:list', async () => {
    // Routed through shared dedup so concurrent cron:list IPC calls (e.g. user
    // navigates to Automation page from two different entry points) reuse one
    // OpenClaw process instead of spawning two each loading all plugins.
    const jsonOutput = await dedupedCronList(deps.readShellOutputAsync, 'openclaw cron list --json 2>&1', CRON_LIST_TIMEOUT_MS);
    const parsed = parseJsonShellOutput<{ jobs?: unknown[] } | unknown[]>(jsonOutput);
    if (parsed) {
      const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : [];
      return { jobs };
    }

    const plainOutput = await dedupedCronList(deps.readShellOutputAsync, 'openclaw cron list 2>&1', CRON_LIST_TIMEOUT_MS);
    if (!plainOutput) {
      return { jobs: [], error: 'OpenClaw not available' };
    }

    return { jobs: parsePlainCronLines(plainOutput), raw: true };
  });

  ipcMain.handle('cron:add', async (_event, input: unknown, legacyCommand?: unknown) => {
    const jobInput = normalizeCronAddInput(input, legacyCommand);
    if (!jobInput) {
      return { success: false, error: 'A schedule and instruction are required.' };
    }

    try {
      const output = await deps.runSpawnAsync('openclaw', buildModernCronAddArgs(jobInput), CRON_MUTATION_TIMEOUT_MS);
      return {
        success: true,
        output,
        job: parseJsonShellOutput(output) ?? undefined,
      };
    } catch (error) {
      const errorText = toErrorMessage(error);
      const legacyArgs = buildLegacyCronAddArgs(jobInput);
      if (legacyArgs && canFallbackToLegacy(errorText)) {
        try {
          const legacyOutput = await deps.runSpawnAsync('openclaw', legacyArgs, CRON_MUTATION_TIMEOUT_MS);
          return { success: true, output: legacyOutput, compatibility: 'legacy-cli' };
        } catch (legacyError) {
          return { success: false, error: toErrorMessage(legacyError) };
        }
      }
      return { success: false, error: errorText };
    }
  });

  ipcMain.handle('cron:remove', async (_event, id: string) => {
    const jobId = typeof id === 'string' ? id.trim() : '';
    if (!jobId) {
      return { success: false, error: 'Task id is required.' };
    }

    try {
      const output = await deps.runSpawnAsync('openclaw', ['cron', 'remove', jobId], CRON_MUTATION_TIMEOUT_MS);
      return { success: true, output };
    } catch (error) {
      return { success: false, error: toErrorMessage(error) };
    }
  });
}