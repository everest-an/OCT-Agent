import { describe, expect, it, vi } from 'vitest';

import { findPrebindingGatewayPids } from '../../electron/gateway-startup-guards';

describe('findPrebindingGatewayPids', () => {
  it('parses Windows CIM output and strips current pid / invalid lines', async () => {
    const readShellOutput = vi.fn().mockResolvedValue('4321\r\n0\r\nnot-a-pid\r\n1234\r\n');

    const result = await findPrebindingGatewayPids('win32', readShellOutput, 1234);

    expect(result).toEqual([4321]);
    expect(readShellOutput).toHaveBeenCalledWith(
      expect.stringContaining('Get-CimInstance Win32_Process'),
      8000,
    );
  });

  it('parses Unix pgrep output and strips current pid', async () => {
    const readShellOutput = vi.fn().mockResolvedValue('888\n999\n');

    const result = await findPrebindingGatewayPids('darwin', readShellOutput, 999);

    expect(result).toEqual([888]);
    expect(readShellOutput).toHaveBeenCalledWith(
      'pgrep -f "openclaw.*(gateway.*run|openclaw-gateway)" 2>/dev/null || true',
      5000,
    );
  });

  it('returns empty list for blank output', async () => {
    const readShellOutput = vi.fn().mockResolvedValue('  \n\r\n');

    const result = await findPrebindingGatewayPids('linux', readShellOutput, 1);

    expect(result).toEqual([]);
  });
});