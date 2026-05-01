const BASE =
  process.env.NEXT_PUBLIC_HL_SIGNALS_API_URL?.replace(/\/$/, "") ??
  "http://localhost:8000";

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
  cohort_status: "active" | "dropped";
  in_cohort_since: string;
  last_seen: string;
}

export interface TopTrader {
  address: string;
  size_usd: number;
}

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

  getDivergence: () =>
    get<{ data: unknown[] }>("/api/signals/divergence"),

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
};
