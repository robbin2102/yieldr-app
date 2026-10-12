export const errors: Record<string, string> = {
  force_fresh_disabled: "Force-fresh debugging is disabled on this deployment. Standard submissions already create a fresh scan.",
  position_revision_mismatch: "Position records no longer match this saved analysis. The chart is withheld until they can be reconciled.",
  invalid_wallet: "Enter a valid EVM (0x…) or Solana wallet address.",
  non_fomo_or_unindexed:
    "This wallet is not currently recognized as an indexed Fomo wallet. Edge Detection initially supports Fomo trading wallets.",
  rate_limited: "Too many requests. Please wait a minute and try again.",
  analysis_pending:
    "This wallet is indexed, but a compatible analysis is not available yet.",
  service_unavailable:
    "The data service is temporarily unavailable. Please try again.",
  configuration_unavailable: "The data service is not configured yet.",
  scan_not_found: "This scan could not be found. Start again with your wallet.",
  result_unavailable: "This versioned result is unavailable.",
  analysis_window_unavailable: "The analysis window could not be verified.",
};
/** Bound every UI request; HTML 404s and disconnected servers must be actionable. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const abort = () => controller.abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  if (init?.signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(errors[data?.error] || (response.status === 404
        ? "This page’s data endpoint was not found. Reload the page, then try again."
        : "We couldn’t load this data. Please try again."));
    }
    if (data === null) throw new Error("The server returned an unreadable response. Reload the page and try again.");
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The request timed out. Check that the local server is running, then retry.");
    if (error instanceof TypeError) throw new Error("Unable to reach the server. Check your connection and retry.");
    throw error;
  } finally {
    clearTimeout(timer);
    init?.signal?.removeEventListener("abort", abort);
  }
}
