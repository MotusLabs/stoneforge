/**
 * RateLimitBanner - Site-wide banner shown when the dispatch daemon is paused due to rate limits
 *
 * Displays a warning banner between the header and main content area when the daemon
 * is sleeping due to rate limits. Shows the wake-up time, a "Wake Now" button, and
 * a dismiss (X) button. Automatically reappears if a new rate limit event occurs.
 *
 * Visibility follows the daemon's paused definition (worker dispatch tiers,
 * design D7): the banner is shown only when the status reports `isPaused`,
 * which is true only when every enabled ephemeral worker's account is
 * limited. A partial limit (some accounts limited, at least one still
 * available) leaves the banner hidden.
 */

import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Clock, X, Loader2, Settings } from 'lucide-react';
import { useDaemonStatus, useWakeDaemon } from '../../api/hooks';

/**
 * Shape of the daemon-status payload the banner cares about.
 * Matches `DaemonStatusResponse['rateLimit']` from `api/hooks/useDaemon`.
 */
export interface RateLimitBannerStatus {
  rateLimit?: {
    isPaused?: boolean;
    limits?: Array<{ executable: string; resetsAt: string }>;
    soonestReset?: string;
  };
}

/**
 * Decides whether the rate-limit banner should be visible for a given
 * daemon-status payload and dismiss state.
 *
 * Hidden when the status is missing, when `isPaused` is false (partial
 * limit — at least one eligible worker's account is still unlimited), or
 * when the user dismissed the banner for the current `soonestReset` value.
 * A later rate-limit event changes `soonestReset`, which re-shows the banner.
 */
export function shouldShowRateLimitBanner(
  status: RateLimitBannerStatus | undefined | null,
  dismissedUntil: string | null
): boolean {
  if (status?.rateLimit?.isPaused !== true) {
    return false;
  }
  const soonestReset = status.rateLimit.soonestReset;
  if (dismissedUntil && soonestReset && dismissedUntil === soonestReset) {
    return false;
  }
  return true;
}

/**
 * Formats an ISO date string into a human-readable time string.
 * Shows relative time if within 60 minutes, otherwise shows absolute time.
 */
function formatWakeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs <= 0) {
    return 'any moment now';
  }

  const diffMinutes = Math.ceil(diffMs / 60000);

  if (diffMinutes <= 1) {
    return 'in less than a minute';
  }

  if (diffMinutes < 60) {
    return `in ${diffMinutes} minute${diffMinutes === 1 ? '' : 's'}`;
  }

  // Show absolute time for longer waits
  return `at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

export function RateLimitBanner() {
  const { data: status } = useDaemonStatus();
  const wakeDaemon = useWakeDaemon();

  // Track which soonestReset timestamp the user has dismissed.
  // When soonestReset changes (new rate limit event), the banner reappears.
  const [dismissedUntil, setDismissedUntil] = useState<string | null>(null);

  const soonestReset = status?.rateLimit?.soonestReset;
  const limits = status?.rateLimit?.limits ?? [];

  // Don't render anything if not paused (partial limit) or dismissed
  const isVisible = shouldShowRateLimitBanner(status, dismissedUntil);
  if (!isVisible) {
    return null;
  }

  const handleDismiss = () => {
    if (soonestReset) {
      setDismissedUntil(soonestReset);
    }
  };

  const handleWakeNow = () => {
    wakeDaemon.mutate();
  };

  const wakeTimeText = soonestReset ? formatWakeTime(soonestReset) : 'soon';

  // Build executable names text from limits array
  const executableNames = limits.map((l) => l.executable);
  const rateLimitDetail = executableNames.length > 0
    ? ` — ${executableNames.join(', ')} hit ${executableNames.length === 1 ? 'its' : 'their'} rate limit${executableNames.length === 1 ? '' : 's'}.`
    : ' — rate limit reached.';

  return (
    <div
      /* container-based: responds to main content column @container width */
      className="flex items-center gap-3 px-4 @md:px-6 py-2 bg-[var(--color-warning-bg)] border-b border-[var(--color-warning)]/30"
      role="alert"
      data-testid="rate-limit-banner"
    >
      <Clock className="w-4 h-4 text-[var(--color-warning-text)] flex-shrink-0" />

      <p className="flex-1 text-sm text-[var(--color-warning-text)]">
        <span className="font-medium">Dispatch paused</span>
        <span className="hidden @sm:inline">{rateLimitDetail}</span>
        {' '}Waking {wakeTimeText}.
      </p>

      <Link
        to="/settings"
        search={{ tab: 'preferences' }}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md
          text-[var(--color-warning-text)]
          hover:bg-[var(--color-warning)]/20
          border border-transparent
          transition-colors duration-150
          flex-shrink-0"
        data-testid="rate-limit-configure-button"
      >
        <Settings className="w-3 h-3" />
        <span className="hidden @md:inline">Configure</span>
      </Link>

      <button
        onClick={handleWakeNow}
        disabled={wakeDaemon.isPending}
        className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md
          bg-[var(--color-warning)]/20 text-[var(--color-warning-text)]
          hover:bg-[var(--color-warning)]/30
          border border-[var(--color-warning)]/30
          transition-colors duration-150
          disabled:opacity-50 disabled:cursor-not-allowed
          flex-shrink-0"
        data-testid="rate-limit-wake-button"
      >
        {wakeDaemon.isPending ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Waking...</span>
          </>
        ) : (
          <span>Wake Now</span>
        )}
      </button>

      <button
        onClick={handleDismiss}
        className="p-1 rounded-md text-[var(--color-warning-text)] hover:bg-[var(--color-warning)]/20 transition-colors duration-150 flex-shrink-0"
        aria-label="Dismiss rate limit banner"
        data-testid="rate-limit-dismiss-button"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
