// Shared types for the App Doctor subsystem.

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type Fixability = 'auto' | 'manual' | 'none';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  message: string;
  fixable: Fixability;
  fixDescription?: string;
  detail?: string;
}

export interface DoctorReport {
  timestamp: number;
  checks: CheckResult[];
  summary: { pass: number; warn: number; fail: number; skipped: number };
}

export interface FixResult {
  id: string;
  success: boolean;
  message: string;
}

export interface DoctorDeps {
  shellExec: (cmd: string, timeout?: number) => Promise<string | null>;
  shellRun: (cmd: string, timeout?: number) => Promise<string>;
  homedir: string;
  platform: NodeJS.Platform;
}

// Shared context built once per runChecks/runFix call and reused by all check functions.
export interface Ctx {
  nodeVersion: string | null;
  nodePath: string | null;
  openclawVersion: string | null;
  openclawPath: string | null;
  openclawPackageDir: string | null;
  openclawCandidates: string[];
  npmPrefix: string | null;
  configPath: string;
  config: any | null;
  deps: DoctorDeps;
}
