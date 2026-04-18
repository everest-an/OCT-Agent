export type ReadShellOutput = (command: string, timeoutMs: number) => Promise<string>;

export async function findPrebindingGatewayPids(
  platform: NodeJS.Platform,
  readShellOutput: ReadShellOutput,
  currentPid: number,
): Promise<number[]> {
  let output = '';

  if (platform === 'win32') {
    output = await readShellOutput(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match \'openclaw.*(dist[\\\\/]index\\.js|openclaw\\.mjs).*gateway.*run\' } | Select-Object -ExpandProperty ProcessId" 2>NUL',
      8000,
    );
  } else {
    output = await readShellOutput(
      'pgrep -f "openclaw.*(gateway.*run|openclaw-gateway)" 2>/dev/null || true',
      5000,
    );
  }

  return (output || '')
    .split(/\r?\n/)
    .map((line) => parseInt(line.trim(), 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== currentPid);
}