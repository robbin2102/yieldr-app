"use client";

import { useState } from "react";
import { hlSignals } from "@/lib/hyperliquid-signals";

interface FilterConfig {
  min_av: number;
  max_av: number;
  min_month_vlm: number;
  min_pnl_av_ratio: number;
  min_month_eff: number;
  min_roi_ratio: number;
  filter_roi_cap_enabled: boolean;
  filter_efficiency_enabled: boolean;
  filter_roi_ratio_enabled: boolean;
  max_month_roi: number;
  max_all_roi: number;
}

interface FilterPanelProps {
  initialConfig: FilterConfig;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className="text-gray-400 w-28 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-green-500"
      />
      <span className="text-green-400 w-20 text-right">{format(value)}</span>
    </div>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between text-xs font-mono">
      <span className="text-gray-400">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`px-2 py-0.5 rounded text-xs font-bold ${value ? "bg-green-700 text-green-200" : "bg-gray-700 text-gray-500"}`}
      >
        {value ? "ON" : "OFF"}
      </button>
    </div>
  );
}

export function FilterPanel({ initialConfig }: FilterPanelProps) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState<FilterConfig>(initialConfig);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof FilterConfig>(key: K, val: FilterConfig[K]) {
    setCfg((c) => ({ ...c, [key]: val }));
  }

  async function save() {
    setSaving(true);
    try {
      await hlSignals.updateConfig({ filter_settings: cfg });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        onClick={() => setOpen((o) => !o)}
        className="bg-gray-800 border border-gray-600 text-gray-300 text-xs font-mono px-3 py-2 rounded hover:bg-gray-700"
      >
        ⚙ Filters {open ? "▼" : "▲"}
      </button>

      {open && (
        <div className="absolute bottom-10 right-0 w-80 bg-gray-950 border border-gray-700 rounded p-4 shadow-xl space-y-2">
          <p className="text-gray-400 text-xs font-mono font-bold mb-2">FILTER SETTINGS</p>

          <SliderRow
            label="Min AV"
            value={cfg.min_av}
            min={10_000}
            max={500_000}
            step={10_000}
            onChange={(v) => set("min_av", v)}
            format={(v) => `$${(v / 1000).toFixed(0)}K`}
          />
          <SliderRow
            label="Min Month VLM"
            value={cfg.min_month_vlm}
            min={100_000}
            max={10_000_000}
            step={100_000}
            onChange={(v) => set("min_month_vlm", v)}
            format={(v) => `$${(v / 1_000_000).toFixed(1)}M`}
          />
          <SliderRow
            label="Min PnL/AV"
            value={cfg.min_pnl_av_ratio}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => set("min_pnl_av_ratio", v)}
            format={(v) => `${(v * 100).toFixed(0)}%`}
          />
          <SliderRow
            label="Min Month Eff"
            value={cfg.min_month_eff}
            min={0}
            max={0.05}
            step={0.001}
            onChange={(v) => set("min_month_eff", v)}
            format={(v) => `${(v * 100).toFixed(1)}%`}
          />
          <SliderRow
            label="Min ROI Ratio"
            value={cfg.min_roi_ratio}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => set("min_roi_ratio", v)}
            format={(v) => `${v.toFixed(2)}x`}
          />

          <div className="border-t border-gray-800 pt-2 space-y-1">
            <ToggleRow
              label="ROI Cap"
              value={cfg.filter_roi_cap_enabled}
              onChange={(v) => set("filter_roi_cap_enabled", v)}
            />
            <ToggleRow
              label="Efficiency Filter"
              value={cfg.filter_efficiency_enabled}
              onChange={(v) => set("filter_efficiency_enabled", v)}
            />
            <ToggleRow
              label="ROI Ratio Filter"
              value={cfg.filter_roi_ratio_enabled}
              onChange={(v) => set("filter_roi_ratio_enabled", v)}
            />
          </div>

          <button
            onClick={save}
            disabled={saving}
            className="w-full bg-green-800 hover:bg-green-700 text-green-200 text-xs font-mono font-bold py-1.5 rounded mt-2 disabled:opacity-50"
          >
            {saving ? "Saving…" : saved ? "Saved ✓" : "Save & Apply"}
          </button>
          <p className="text-gray-600 text-xs font-mono text-center">
            Takes effect on next daily discovery run
          </p>
        </div>
      )}
    </div>
  );
}
