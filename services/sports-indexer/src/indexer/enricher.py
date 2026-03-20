"""Enricher: derives betting stats, tempo, context, xG proxy, referee profile,
and alpha signals from existing API-Football data. No extra API calls."""

from datetime import datetime, timezone, timedelta


# ── Betting Stats ──

def compute_betting_stats(form_results: list, venue_filter: str | None = None) -> dict:
    """Derive BTTS%, O/U 2.5%, clean sheet%, etc. from match results."""
    matches = form_results
    if venue_filter:
        matches = [m for m in matches if m.get("venue") == venue_filter]
    if not matches:
        return {}

    n = len(matches)
    btts = sum(1 for m in matches if m["goals_for"] > 0 and m["goals_against"] > 0)
    over_25 = sum(1 for m in matches if m["goals_for"] + m["goals_against"] >= 3)
    clean_sheets = sum(1 for m in matches if m["goals_against"] == 0)
    failed_to_score = sum(1 for m in matches if m["goals_for"] == 0)

    return {
        "btts_pct": round(btts / n * 100, 1),
        "over_25_pct": round(over_25 / n * 100, 1),
        "under_25_pct": round((n - over_25) / n * 100, 1),
        "clean_sheet_pct": round(clean_sheets / n * 100, 1),
        "failed_to_score_pct": round(failed_to_score / n * 100, 1),
        "avg_total_goals": round(sum(m["goals_for"] + m["goals_against"] for m in matches) / n, 2),
        "avg_goals_scored": round(sum(m["goals_for"] for m in matches) / n, 2),
        "avg_goals_conceded": round(sum(m["goals_against"] for m in matches) / n, 2),
    }


# ── Team Tempo ──

def compute_tempo(form_stats: list) -> dict:
    """Aggregate match-level statistics across recent fixtures."""
    if not form_stats:
        return {}
    n = len(form_stats)

    def safe_avg(key):
        vals = [s.get(key) for s in form_stats if s.get(key) is not None]
        return round(sum(vals) / len(vals), 1) if vals else None

    result = {
        "avg_shots_per_game": safe_avg("shots_total"),
        "avg_shots_on_target_per_game": safe_avg("shots_on_target"),
        "avg_possession": safe_avg("possession"),
        "avg_corners_for": safe_avg("corners"),
        "avg_fouls_committed": safe_avg("fouls"),
        "avg_yellow_cards": safe_avg("yellow_cards"),
        "avg_pass_accuracy": safe_avg("pass_accuracy"),
    }

    total_goals = sum(s.get("goals", 0) for s in form_stats)
    total_shots = sum(s.get("shots_total", 0) for s in form_stats if s.get("shots_total"))
    total_sot = sum(s.get("shots_on_target", 0) for s in form_stats if s.get("shots_on_target"))
    if total_shots > 0:
        result["shot_conversion_rate"] = round(total_goals / total_shots, 3)
    if total_sot > 0:
        result["sot_conversion_rate"] = round(total_goals / total_sot, 3)
    return result


# ── xG Proxy ──

def compute_xg_proxy(team_season: dict, league_avg: dict, prediction: dict | None) -> dict:
    """Approximate expected goals metrics without external xG data."""
    played = max(team_season.get("played", 1), 1)
    team_gf_pg = team_season.get("goals_for", 0) / played
    league_avg_gf = league_avg.get("avg_goals_per_game", 2.7) / 2  # per team

    attacking_index = round(team_gf_pg / league_avg_gf, 2) if league_avg_gf else 1.0
    team_ga_pg = team_season.get("goals_against", 0) / played
    defensive_index = round(team_ga_pg / league_avg_gf, 2) if league_avg_gf else 1.0

    expected_gf = league_avg_gf * attacking_index
    overperformance = round(team_gf_pg - expected_gf, 2)

    return {
        "attack_strength_pct": prediction.get("attack", 0) if prediction else None,
        "defense_strength_pct": prediction.get("defense", 0) if prediction else None,
        "attacking_index": attacking_index,
        "defensive_index": defensive_index,
        "goals_vs_expected": overperformance,
        "likely_overperforming": overperformance > 0.3,
    }


# ── Context ──

def compute_context(form_results: list, team_season: dict) -> dict:
    """Derive fixture congestion, trends from form data."""
    if not form_results:
        return {}

    dates = []
    for m in form_results:
        d = m.get("date")
        if d:
            try:
                dates.append(datetime.fromisoformat(d.replace("Z", "+00:00")) if isinstance(d, str) else d)
            except (ValueError, TypeError):
                pass
    dates.sort(reverse=True)

    now = datetime.now(timezone.utc)
    days_since_last = (now - dates[0]).days if dates else None
    matches_14d = sum(1 for d in dates if (now - d).days <= 14) if dates else 0

    # Scoring trend
    played = max(team_season.get("played", 1), 1)
    season_avg = team_season.get("goals_for", 0) / played
    last3 = form_results[:3]
    last3_gf = sum(m.get("goals_for", 0) for m in last3) / max(len(last3), 1)
    scoring_trend = (
        "improving" if last3_gf > season_avg * 1.15 else
        "declining" if last3_gf < season_avg * 0.85 else
        "stable"
    )

    return {
        "days_since_last_match": days_since_last,
        "matches_last_14_days": matches_14d,
        "is_congested": matches_14d >= 3,
        "scoring_trend": scoring_trend,
    }


# ── Referee Profile ──

def compute_referee_profile(referee_name: str, historical_fixtures: list, league_avg_cards: float) -> dict:
    """Compute referee tendencies from historical fixtures."""
    if not referee_name:
        return {"name": None, "games_in_dataset": 0}

    ref_matches = [f for f in historical_fixtures if f.get("referee") == referee_name]
    if not ref_matches:
        return {"name": referee_name, "games_in_dataset": 0}

    n = len(ref_matches)
    total_yellows = sum(
        (f.get("match_stats", {}).get("home", {}).get("yellow_cards", 0) or 0) +
        (f.get("match_stats", {}).get("away", {}).get("yellow_cards", 0) or 0)
        for f in ref_matches
    )
    avg_cards = round(total_yellows / n, 1) if n else 0
    tendency = (
        "strict" if avg_cards > league_avg_cards * 1.15 else
        "lenient" if avg_cards < league_avg_cards * 0.85 else
        "average"
    )

    return {
        "name": referee_name,
        "avg_yellow_cards_per_game": avg_cards,
        "games_in_dataset": n,
        "card_tendency": tendency,
    }


# ── Form Momentum ──

def score_momentum(last5_results: list) -> str:
    pts = sum(3 if r == "W" else 1 if r == "D" else 0 for r in last5_results)
    if pts >= 12:
        return "strong"
    if pts >= 8:
        return "steady"
    if pts >= 4:
        return "declining"
    return "poor"


# ── Match Context ──

def compute_match_context(
    home_betting: dict, away_betting: dict,
    home_tempo: dict, away_tempo: dict,
    league_avg: dict,
    home_team_id: int = 0, away_team_id: int = 0,
    known_derbies: dict | None = None,
) -> dict:
    """High-level match character assessment."""
    home_over = home_betting.get("over_25_pct", 50) if home_betting else 50
    away_over = away_betting.get("over_25_pct", 50) if away_betting else 50
    combined_over = (home_over + away_over) / 2

    home_shots = home_tempo.get("avg_shots_per_game", 12) if home_tempo else 12
    away_shots = away_tempo.get("avg_shots_per_game", 12) if away_tempo else 12
    combined_shots = home_shots + away_shots
    league_avg_shots = league_avg.get("avg_shots_per_game", 24) if league_avg else 24

    tempo = (
        "high" if combined_shots > league_avg_shots * 1.15 else
        "low" if combined_shots < league_avg_shots * 0.85 else
        "average"
    )
    goal_env = "high" if combined_over > 60 else "low" if combined_over < 40 else "medium"

    is_derby = False
    if known_derbies:
        pair = tuple(sorted([home_team_id, away_team_id]))
        is_derby = pair in known_derbies or (home_team_id, away_team_id) in known_derbies

    return {
        "is_derby": is_derby,
        "combined_tempo_rating": tempo,
        "expected_goal_environment": goal_env,
    }


# ── Odds & Alpha ──

def remove_vig(home_odds: float, draw_odds: float, away_odds: float) -> dict:
    raw = [1 / home_odds, 1 / draw_odds, 1 / away_odds]
    total = sum(raw)
    return {
        "home_win": round(raw[0] / total, 4),
        "draw": round(raw[1] / total, 4),
        "away_win": round(raw[2] / total, 4),
    }


def remove_vig_2way(odds_a: float, odds_b: float) -> tuple:
    raw = [1 / odds_a, 1 / odds_b]
    total = sum(raw)
    return (round(raw[0] / total, 4), round(raw[1] / total, 4))


def compute_alpha(bookmaker_implied: dict, polymarket_prices: dict) -> dict:
    """Detect price discrepancies between bookmaker implied prob and Polymarket."""
    signals = {}
    for key in ["home_win", "draw", "away_win"]:
        bm = bookmaker_implied.get(key, 0)
        poly = polymarket_prices.get(key, 0)
        if bm and poly:
            delta = round(bm - poly, 4)
            if abs(delta) > 0.02:
                direction = "underpriced" if delta > 0 else "overpriced"
                signals[key] = {
                    "bookmaker_implied": bm,
                    "polymarket_price": poly,
                    "delta": delta,
                    "signal": f"Polymarket {direction} by {abs(delta) * 100:.1f}% vs bookmaker line",
                }
    return signals


# ── Live Insights ──

def generate_live_insight(match: dict, stats: dict) -> str | None:
    """Natural language insight from live match data."""
    home = match.get("home", {}).get("name", "Home")
    away = match.get("away", {}).get("name", "Away")
    home_stats = stats.get("home", {})
    away_stats = stats.get("away", {})
    score_h = match.get("score", {}).get("home", 0) or 0
    score_a = match.get("score", {}).get("away", 0) or 0

    insights = []
    poss = home_stats.get("possession")
    if poss and isinstance(poss, str):
        poss = int(poss.replace("%", ""))
    if poss and poss > 65 and score_h == 0:
        insights.append(f"{home} dominating possession ({poss}%) but scoreless")

    home_sot = home_stats.get("shots_on_target", 0) or 0
    away_sot = away_stats.get("shots_on_target", 0) or 0
    if home_sot >= away_sot * 3 and home_sot >= 4:
        insights.append(f"{home} have {home_sot} SOT vs {away}'s {away_sot}")

    home_corners = home_stats.get("corners", 0) or 0
    away_corners = away_stats.get("corners", 0) or 0
    if home_corners + away_corners >= 10:
        insights.append(f"High corner count: {home_corners + away_corners} total")

    total_cards = (home_stats.get("yellow_cards", 0) or 0) + (away_stats.get("yellow_cards", 0) or 0)
    elapsed = match.get("status", {}).get("elapsed", 0) or 0
    if total_cards >= 4 and elapsed < 60:
        insights.append(f"Already {total_cards} cards at {elapsed}' — cards over looking strong")

    return " | ".join(insights) if insights else None


# ── Conviction ──

def compute_conviction(alpha_signals: dict, injuries: dict, h2h: dict, context: dict) -> str:
    score = 0
    max_d = max(
        (abs(s.get("delta", 0)) for s in alpha_signals.values() if isinstance(s, dict)),
        default=0,
    )
    score += 3 if max_d > 0.05 else 2 if max_d > 0.03 else 1 if max_d > 0.02 else 0

    if injuries.get("home_absent_impact_score", 0) > 0.5:
        score += 1
    if injuries.get("away_absent_impact_score", 0) > 0.5:
        score += 1

    v = h2h.get("home_venue_record", {})
    if v.get("played", 0) >= 5 and v.get("home_wins", 0) / v["played"] > 0.7:
        score += 1

    if context.get("is_congested"):
        score += 1

    if score >= 5:
        return "high"
    if score >= 3:
        return "medium"
    return "low"


# ── Suggested Edges ──

def generate_suggested_edges(match_doc: dict) -> list:
    """Generate natural language edge suggestions for the agent."""
    edges = []
    signals = match_doc.get("alpha_signals", {})

    ml = signals.get("moneyline_edge", {})
    if ml.get("signal"):
        edges.append(ml["signal"])

    hb = match_doc.get("home_betting_stats", {})
    ab = match_doc.get("away_betting_stats", {})
    if hb.get("over_25_pct", 0) > 58 and ab.get("over_25_pct", 0) > 58:
        edges.append("Over 2.5 — both teams >58% O/U rate. High-tempo matchup.")
    if hb.get("btts_pct", 0) > 60 and ab.get("btts_pct", 0) > 60:
        edges.append("BTTS Yes — both teams' BTTS rate >60%.")

    ref = match_doc.get("referee_profile", {})
    if ref.get("card_tendency") == "strict":
        edges.append(
            f"Cards over — {ref.get('name')} averages {ref.get('avg_yellow_cards_per_game')} yellows (above league avg)."
        )

    away_ctx = match_doc.get("away_context", {})
    if away_ctx.get("is_congested"):
        away_name = match_doc.get("away", {}).get("name", "Away team")
        edges.append(
            f"{away_name} fixture congestion ({away_ctx.get('matches_last_14_days')} matches in 14 days). Fatigue factor."
        )

    return edges
