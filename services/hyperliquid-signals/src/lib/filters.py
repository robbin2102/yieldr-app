from ..config import Settings


def apply_filters(rows: list[dict], cfg: Settings) -> list[dict]:
    """Apply all configured filters to raw leaderboard rows. Returns enriched dicts."""
    result = []
    for r in rows:
        av = float(r.get("accountValue", 0))
        if av < cfg.min_av or av > cfg.max_av:
            continue

        wp = dict(r.get("windowPerformances", []))
        try:
            day_pnl = float(wp["day"]["pnl"])
            week_pnl = float(wp["week"]["pnl"])
            month_pnl = float(wp["month"]["pnl"])
            all_pnl = float(wp["allTime"]["pnl"])
            month_roi = float(wp["month"]["roi"])
            all_roi = float(wp["allTime"]["roi"])
            month_vlm = float(wp["month"]["vlm"])
            all_vlm = float(wp["allTime"]["vlm"])
        except (KeyError, TypeError, ValueError):
            continue

        # Daily PnL must be positive
        if day_pnl <= 0:
            continue

        # Minimum ROI thresholds — core quality gate
        if month_roi < cfg.min_month_roi:
            continue
        if all_roi < cfg.min_all_roi:
            continue

        # Min monthly volume
        if month_vlm < cfg.min_month_vlm:
            continue

        # PnL to AV ratio (all-time PnL must be meaningful vs account size)
        if all_pnl < av * cfg.min_pnl_av_ratio:
            continue

        month_eff = month_pnl / month_vlm if month_vlm > 0 else 0.0
        all_eff = all_pnl / all_vlm if all_vlm > 0 else 0.0

        # Efficiency filter
        if cfg.filter_efficiency_enabled and month_eff < cfg.min_month_eff:
            continue

        result.append(
            {
                "address": r.get("ethAddress", "").lower(),
                "display_name": r.get("displayName") or None,
                "account_value": av,
                "day_pnl": day_pnl,
                "week_pnl": week_pnl,
                "month_pnl": month_pnl,
                "all_pnl": all_pnl,
                "month_roi": month_roi,
                "all_roi": all_roi,
                "month_vlm": month_vlm,
                "all_vlm": all_vlm,
                "month_eff": month_eff,
                "all_eff": all_eff,
                "roi_ratio": all_roi / month_roi if month_roi > 0 else 0.0,
            }
        )
    return result


def load_config_overrides(db_config: dict | None, base: Settings) -> Settings:
    """Overlay filter settings from DB config doc onto base settings."""
    if not db_config:
        return base
    overrides = db_config.get("filter_settings", {})
    if not overrides:
        return base
    data = base.model_dump()
    for key, val in overrides.items():
        if key in data:
            data[key] = val
    return Settings(**{k.upper(): v for k, v in data.items()})
