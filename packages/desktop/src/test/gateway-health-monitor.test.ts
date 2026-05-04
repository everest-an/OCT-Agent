import { describe, expect, it } from 'vitest';

import { createGatewayHealthMonitor } from '../../electron/gateway-health-monitor';

describe('gateway health monitor', () => {
  it('transitions healthy -> degraded -> manual_required on sustained failures', () => {
    const monitor = createGatewayHealthMonitor({
      degradedThreshold: 2,
      manualThreshold: 4,
      selfHealCooldownMs: 60_000,
    });

    let r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 1000 });
    expect(r.state).toBe('healthy');
    expect(r.event).toBeUndefined();

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 2000 });
    expect(r.state).toBe('degraded');
    expect(r.event?.reason).toBe('degraded-threshold');

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 3000 });
    expect(r.state).toBe('degraded');
    expect(r.event).toBeUndefined();

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 4000 });
    expect(r.state).toBe('manual_required');
    expect(r.event?.reason).toBe('manual-threshold');
  });

  it('emits recovered when gateway becomes reachable again', () => {
    const monitor = createGatewayHealthMonitor({ degradedThreshold: 1, manualThreshold: 3 });

    monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 1000 });
    const recovered = monitor.tick({ gatewayReachable: true, gatewayRepairActive: false, now: 2000 });

    expect(recovered.state).toBe('healthy');
    expect(recovered.event?.reason).toBe('recovered');
  });

  it('rate-limits self-heal with cooldown and skips when repair is active', () => {
    const monitor = createGatewayHealthMonitor({
      degradedThreshold: 2,
      manualThreshold: 10,
      selfHealThreshold: 2,
      selfHealCooldownMs: 5000,
    });

    let r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 1000 });
    expect(r.shouldSelfHeal).toBe(false);

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 2000 });
    expect(r.state).toBe('degraded');
    expect(r.shouldSelfHeal).toBe(false);

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 7000 });
    expect(r.shouldSelfHeal).toBe(true);

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 8000 });
    expect(r.shouldSelfHeal).toBe(false);

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: true, now: 13000 });
    expect(r.shouldSelfHeal).toBe(false);

    r = monitor.tick({ gatewayReachable: false, gatewayRepairActive: false, now: 14000 });
    expect(r.shouldSelfHeal).toBe(true);
  });
});
