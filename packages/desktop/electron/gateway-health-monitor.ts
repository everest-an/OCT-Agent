export type GatewayHealthState = 'healthy' | 'degraded' | 'manual_required';

export interface GatewayHealthSnapshot {
  gatewayReachable: boolean;
  gatewayRepairActive: boolean;
  now: number;
}

export interface GatewayHealthEvent {
  state: GatewayHealthState;
  previous: GatewayHealthState;
  reason: 'degraded-threshold' | 'manual-threshold' | 'recovered';
}

export interface GatewayHealthTickResult {
  state: GatewayHealthState;
  previous: GatewayHealthState;
  consecutiveFailures: number;
  shouldSelfHeal: boolean;
  event?: GatewayHealthEvent;
}

interface GatewayHealthMonitorOptions {
  degradedThreshold?: number;
  manualThreshold?: number;
  selfHealThreshold?: number;
  selfHealCooldownMs?: number;
}

const DEFAULT_OPTIONS: Required<GatewayHealthMonitorOptions> = {
  degradedThreshold: 2,
  manualThreshold: 6,
  selfHealThreshold: 2,
  selfHealCooldownMs: 60_000,
};

export function createGatewayHealthMonitor(options?: GatewayHealthMonitorOptions) {
  const cfg = { ...DEFAULT_OPTIONS, ...(options || {}) };

  let state: GatewayHealthState = 'healthy';
  let consecutiveFailures = 0;
  let lastSelfHealAt = 0;

  const currentState = () => state;

  const tick = (snapshot: GatewayHealthSnapshot): GatewayHealthTickResult => {
    const previous = state;
    let event: GatewayHealthEvent | undefined;

    if (snapshot.gatewayReachable) {
      consecutiveFailures = 0;
      if (state !== 'healthy') {
        state = 'healthy';
        event = {
          state,
          previous,
          reason: 'recovered',
        };
      }

      return {
        state,
        previous,
        consecutiveFailures,
        shouldSelfHeal: false,
        event,
      };
    }

    consecutiveFailures += 1;

    if (consecutiveFailures >= cfg.manualThreshold) {
      if (state !== 'manual_required') {
        state = 'manual_required';
        event = {
          state,
          previous,
          reason: 'manual-threshold',
        };
      }
    } else if (consecutiveFailures >= cfg.degradedThreshold) {
      if (state !== 'degraded') {
        state = 'degraded';
        event = {
          state,
          previous,
          reason: 'degraded-threshold',
        };
      }
    }

    const eligibleByThreshold = consecutiveFailures >= cfg.selfHealThreshold;
    const eligibleByCooldown = (snapshot.now - lastSelfHealAt) >= cfg.selfHealCooldownMs;
    const shouldSelfHeal = state === 'degraded'
      && eligibleByThreshold
      && eligibleByCooldown
      && !snapshot.gatewayRepairActive;

    if (shouldSelfHeal) {
      lastSelfHealAt = snapshot.now;
    }

    return {
      state,
      previous,
      consecutiveFailures,
      shouldSelfHeal,
      event,
    };
  };

  return {
    tick,
    currentState,
  };
}
