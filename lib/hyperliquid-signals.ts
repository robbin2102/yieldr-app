// All API calls go through the Next.js proxy at /api/hl/...
// Railway URL is kept server-side in HL_SIGNALS_API_URL (no NEXT_PUBLIC_ needed).
const BASE = "/api/hl";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`HL Signals API error: ${res.status} ${path}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HL Signals API error: ${res.status} ${path}`);
  return res.json();
}

export interface Trader {
  address: string;
  display_name: string | null;
  account_value: number;
  month_roi: number;
  all_roi: number;
  month_pnl: number;
  all_pnl: number;
  month_vlm: number;
  month_eff: number;
  roi_ratio: number;
  skill_score?: number;
  skill_quartile?: 1 | 2 | 3 | 4;
  cohort_status: "active" | "dropped";
  in_cohort_since: string;
  last_seen: string;
}

export interface TopTrader {
  address: string;
  size_usd: number;
}

/** Legacy convergence signal (still used by existing dashboard) */
export interface ConvergenceSignal {
  snapshot_ts: string;
  coin: string;
  side: "LONG" | "SHORT";
  n_traders: number;
  total_usd: number;
  pct_of_coin: number;
  pct_of_all_portfolio: number;
  avg_mo_roi: number;
  conviction: number;
  top_traders: TopTrader[];
}

/** v2 — per-coin snapshot metrics */
export interface CoinMetrics {
  snapshot_ts: string;
  coin: string;
  long_usd: number;
  short_usd: number;
  long_count: number;
  short_count: number;
  total_count: number;
  total_usd: number;
  count_conviction: number;
  dollar_conviction: number;
  cohort_participation: number;
  active_cohort_size: number;
  active_participation: number;
  wt_avg_entry_long: number;
  wt_avg_entry_short: number;
  dominant_side: "LONG" | "SHORT";
  avg_leverage: number;
  portfolio_share: number;
  avg_mo_roi: number;
  q1_long: number;
  q1_short: number;
  q4_long: number;
  q4_short: number;
  top_long: TopTrader[];
  top_short: TopTrader[];
}

/** v2 — one of the 9 named signals */
export interface SignalV2 {
  signal_type:
    | "CONVERGENCE_ACCELERATION"
    | "WHALE_ACTIVITY"
    | "COHORT_DIRECTION_FLIP"
    | "SMART_EXIT"
    | "LEVERAGE_SPIKE"
    | "ASYMMETRIC_POSITIONING"
    | "CAPITAL_ROTATION"
    | "FUNDING_DIVERGENCE"
    | "STALE_POSITION_DECAY";
  coin: string;
  side: "LONG" | "SHORT";
  severity: "HIGH" | "MEDIUM" | "LOW";
  snapshot_ts: string;
  created_at: string;
  metadata: Record<string, unknown>;
  // enriched fields from dashboard endpoint
  count_conviction?: number;
  dollar_conviction?: number;
  cohort_participation?: number;
  total_usd?: number;
  total_count?: number;
}

/** v2 — whale event for Q1 trader */
export interface WhaleEvent {
  address: string;
  coin: string;
  event_type: "WAKEUP" | "SCALEUP" | "FLIP" | "EXIT" | "LEVERAGE_PUSH";
  side: "LONG" | "SHORT";
  size_usd: number;
  ts: string;
  metadata: Record<string, unknown>;
}

/** v2 dashboard response */
export interface DashboardData {
  accelerating: SignalV2[];
  whale_moves: WhaleEvent[];
  direction_flips: SignalV2[];
  exits: SignalV2[];
  snapshot_ts: string | null;
}

export interface Alert {
  id: string;
  coin: string;
  side: "LONG" | "SHORT";
  severity: 1 | 2 | 3;
  alert_type: "TIER_SIGNAL" | "MOMENTUM_ALERT";
  n_traders: number;
  total_usd: number;
  conviction: number;
  acknowledged: boolean;
  created_at: string;
  snapshot_ts: string;
}

export interface TradeAlertStrategyMeta {
  label: string;
  rule: string;
  hold_hours: number;
  backtest_win_pct: number;
  backtest_return_pct: number;
  backtest_horizon_h: number;
  backtest_n: number;
}

export interface TradeAlert {
  strategy: "WAKEUP_LS10" | "LS10_CROSS" | "WHALE_EXIT_FADE";
  coin: string;
  side: "LONG" | "SHORT";
  entry_px: number;
  fired_at: string;
  hold_hours: number;
  hold_until: string;
  status: "OPEN" | "WIN" | "LOSS";
  exit_px: number | null;
  return_pct: number | null;
  current_px?: number;
  live_return_pct?: number;
  trigger_detail: Record<string, unknown>;
  strategy_meta: TradeAlertStrategyMeta;
}

export interface TradeAlertScorecard {
  strategy: string;
  label: string;
  rule: string;
  hold_hours: number;
  backtest_win_pct: number;
  backtest_return_pct: number;
  backtest_horizon_h: number;
  backtest_n: number;
  open: number;
  live_wins: number;
  live_losses: number;
  live_total: number;
  live_win_pct: number | null;
  live_avg_win_pct: number | null;
  live_avg_loss_pct: number | null;
}

export interface PositionChange {
  address: string;
  coin: string;
  change_type: "NEW_POSITION" | "SIZE_CHANGE" | "FLIP" | "CLOSED" | "LEVERAGE_CHANGE";
  previous_state: Record<string, unknown> | null;
  new_state: Record<string, unknown> | null;
  ts: string;
}

export interface CohortChange {
  address: string;
  display_name: string | null;
  change_type: "NEW_ENTRANT" | "DROPPED";
  ts: string;
}

export const hlSignals = {
  getCohort: (page = 1, limit = 50, sortBy = "month_roi") =>
    get<{ data: Trader[]; total: number; page: number }>(
      `/api/cohort?page=${page}&limit=${limit}&sort_by=${sortBy}`
    ),

  getCohortChanges: (days = 7) =>
    get<{ data: CohortChange[]; total: number }>(`/api/cohort/changes?days=${days}`),

  getConvergence: (limit = 30) =>
    get<{ data: ConvergenceSignal[]; snapshot_ts: string | null }>(
      `/api/signals/convergence?limit=${limit}`
    ),

  getDivergence: () => get<{ data: unknown[] }>("/api/signals/divergence"),

  getAlerts: (severity?: number, acknowledged = false) => {
    const params = new URLSearchParams({ acknowledged: String(acknowledged) });
    if (severity !== undefined) params.set("severity", String(severity));
    return get<{ data: Alert[]; total: number }>(`/api/signals/alerts?${params}`);
  },

  getPositionChanges: (since?: number, minSizeUsd?: number, changeType?: string) => {
    const params = new URLSearchParams();
    if (since) params.set("since", String(since));
    if (minSizeUsd) params.set("min_size_usd", String(minSizeUsd));
    if (changeType) params.set("change_type", changeType);
    return get<{ data: PositionChange[]; total: number }>(
      `/api/positions/changes?${params}`
    );
  },

  getCoin: (coin: string, days = 7) =>
    get<{ coin: string; holders: unknown[]; conviction_history: ConvergenceSignal[] }>(
      `/api/coin/${coin}?days=${days}`
    ),

  getTrader: (address: string) =>
    get<{ profile: Trader; positions: unknown[]; recent_changes: PositionChange[] }>(
      `/api/trader/${address}`
    ),

  getHeatmap: (coins = 20, days = 7) =>
    get<{ coins: string[]; snapshots: string[]; matrix: Record<string, Record<string, unknown>> }>(
      `/api/heatmap?coins=${coins}&days=${days}`
    ),

  acknowledgeAlert: (id: string) =>
    post<{ ok: boolean }>(`/api/alerts/${id}/acknowledge`),

  getConfig: () => get<{ data: Record<string, unknown>; source: string }>("/api/config"),

  updateConfig: (body: Record<string, unknown>) =>
    post<{ ok: boolean }>("/api/config", body),

  health: () => get<{ status: string; db: string; ts: string }>("/health"),

  // v2 endpoints
  getDashboard: (hours = 24) =>
    get<DashboardData>(`/api/signals/v2/dashboard?hours=${hours}`),

  getCoinMetrics: (limit = 50) =>
    get<{ data: CoinMetrics[]; snapshot_ts: string | null }>(
      `/api/signals/v2/coin-metrics?limit=${limit}`
    ),

  getCoinMetricsAt: (hoursAgo: number, limit = 200) =>
    get<{ data: CoinMetrics[]; snapshot_ts: string | null }>(
      `/api/signals/v2/coin-metrics?limit=${limit}&hours_ago=${hoursAgo}`
    ),

  getSignalsV2: (signalType?: string, hours = 24) => {
    const params = new URLSearchParams({ hours: String(hours) });
    if (signalType) params.set("signal_type", signalType);
    return get<{ data: SignalV2[]; total: number }>(`/api/signals/v2/signals?${params}`);
  },

  getTradeAlertsActive: () =>
    get<{ data: TradeAlert[]; total: number }>("/api/trade-alerts/active"),

  getTradeAlertsHistory: (days = 30) =>
    get<{ data: TradeAlert[]; total: number }>(`/api/trade-alerts/history?days=${days}`),

  getTradeAlertsScorecard: () =>
    get<{ data: TradeAlertScorecard[] }>("/api/trade-alerts/scorecard"),

  getWhaleEvents: (coin?: string, eventType?: string, hours = 24, limit = 500) => {
    const params = new URLSearchParams({ hours: String(hours), limit: String(limit) });
    if (coin) params.set("coin", coin);
    if (eventType) params.set("event_type", eventType);
    return get<{ data: WhaleEvent[]; total: number }>(`/api/signals/v2/whale-events?${params}`);
  },
};
