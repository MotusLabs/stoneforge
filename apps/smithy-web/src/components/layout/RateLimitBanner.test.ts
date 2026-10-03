/**
 * RateLimitBanner visibility tests (worker dispatch tiers, design D7).
 *
 * The banner keys off `rateLimit.isPaused` in the daemon-status payload.
 * Under the new paused definition that flag is true only when every enabled
 * ephemeral worker's account is limited — a partial limit leaves it false,
 * so the banner stays hidden.
 *
 * These tests feed mocked status payloads (the shape returned by
 * `GET /api/daemon/status`) through `shouldShowRateLimitBanner`, the pure
 * visibility helper the component uses.
 */

import { describe, expect, test } from 'vitest';
import { shouldShowRateLimitBanner, type RateLimitBannerStatus } from './RateLimitBanner';

const RESET_A = '2026-10-03T12:00:00.000Z';
const RESET_B = '2026-10-03T12:30:00.000Z';

/** Status payload for scenario "Partial limit": one account limited, one not. */
function partialLimitStatus(): RateLimitBannerStatus {
  return {
    rateLimit: {
      isPaused: false,
      limits: [{ executable: 'claude-glm', resetsAt: RESET_A }],
      soonestReset: RESET_A,
    },
  };
}

/** Status payload for scenario "All accounts limited": dispatch paused. */
function allAccountsLimitedStatus(): RateLimitBannerStatus {
  return {
    rateLimit: {
      isPaused: true,
      limits: [
        { executable: 'claude-glm', resetsAt: RESET_A },
        { executable: 'claude', resetsAt: RESET_B },
      ],
      soonestReset: RESET_A,
    },
  };
}

/** Status payload during a manual sleep (`sf daemon sleep`). */
function manualSleepStatus(): RateLimitBannerStatus {
  return {
    rateLimit: {
      isPaused: true,
      // No provider limits — the pause is the manual sleep alone
      limits: [],
      manualSleepUntil: RESET_B,
    },
  };
}

describe('shouldShowRateLimitBanner', () => {
  test('scenario "Partial limit": banner is hidden while an eligible account is unlimited', () => {
    expect(shouldShowRateLimitBanner(partialLimitStatus(), null)).toBe(false);
  });

  test('scenario "All accounts limited": banner is shown when dispatch is paused', () => {
    expect(shouldShowRateLimitBanner(allAccountsLimitedStatus(), null)).toBe(true);
  });

  test('hidden when status is missing or has no rateLimit block', () => {
    expect(shouldShowRateLimitBanner(undefined, null)).toBe(false);
    expect(shouldShowRateLimitBanner(null, null)).toBe(false);
    expect(shouldShowRateLimitBanner({}, null)).toBe(false);
  });

  test('hidden when isPaused is explicitly false even if limits are listed', () => {
    // Partial limit still lists the limited accounts with their reset times
    // (spec: "status SHALL list the limited accounts with their reset times
    // and SHALL NOT report dispatch as paused") — the banner stays hidden.
    const status = partialLimitStatus();
    expect(status.rateLimit?.limits?.length).toBeGreaterThan(0);
    expect(shouldShowRateLimitBanner(status, null)).toBe(false);
  });

  test('dismiss hides the banner for the current sleep session', () => {
    expect(shouldShowRateLimitBanner(allAccountsLimitedStatus(), RESET_A)).toBe(false);
  });

  test('a new rate-limit event re-shows the banner after a dismiss', () => {
    // soonestReset changed (new event) → previous dismiss no longer applies
    expect(shouldShowRateLimitBanner(allAccountsLimitedStatus(), RESET_B)).toBe(true);
  });

  test('manual sleep: banner is shown even with no provider limits', () => {
    expect(shouldShowRateLimitBanner(manualSleepStatus(), null)).toBe(true);
  });

  test('manual sleep: dismissed for the manual deadline stays hidden', () => {
    // The dismiss key is the manual sleep deadline, not soonestReset
    expect(shouldShowRateLimitBanner(manualSleepStatus(), RESET_B)).toBe(false);
    // A dismiss keyed on a different timestamp does not apply
    expect(shouldShowRateLimitBanner(manualSleepStatus(), RESET_A)).toBe(true);
  });
});
