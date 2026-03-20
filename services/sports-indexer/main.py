"""Sports Indexer — orchestrator that ties lifecycle, API clients, enricher, and MongoDB together.

Run with: uvicorn main:app --host 0.0.0.0 --port 8080 --reload
Or:       python main.py
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from src.config import (
    PRIORITY_LEAGUES,
    CURRENT_SEASON,
    MAX_TRACKED_MATCHES,
    SCHEDULER_CHECK_INTERVAL_SEC,
    LIVE_POLL_INTERVAL_SEC,
    POLYMARKET_POLL_INTERVAL_SEC,
    KNOWN_DERBIES,
    PORT,
)
from src.db.mongo import get_db, close_db, ensure_indexes
from src.indexer.api_football import APIFootballClient
from src.indexer.polymarket import PolymarketClient
from src.indexer.budget import BudgetTracker
from src.indexer.lifecycle import (
    DISCOVERY, PRE_MATCH, PRE_KICKOFF, LIVE, POST_MATCH, CLOSED,
    should_transition, needs_live_poll, needs_polymarket_poll,
)
from src.indexer.enricher import (
    compute_betting_stats,
    compute_tempo,
    compute_xg_proxy,
    compute_context,
    compute_referee_profile,
    compute_match_context,
    score_momentum,
    remove_vig,
    compute_alpha,
    compute_conviction,
    generate_suggested_edges,
    generate_live_insight,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("orchestrator")

scheduler = AsyncIOScheduler()


# ── API Response Parsers ──


def parse_fixture(raw: dict) -> dict:
    """Convert an API-Football fixture response into our match document shape."""
    fixture = raw.get("fixture", {})
    teams = raw.get("teams", {})
    goals = raw.get("goals", {})
    league = raw.get("league", {})

    return {
        "fixture_id": fixture.get("id"),
        "date": fixture.get("date"),
        "timestamp": fixture.get("timestamp"),
        "referee": fixture.get("referee"),
        "venue": fixture.get("venue", {}).get("name"),
        "status": {
            "long": fixture.get("status", {}).get("long"),
            "short": fixture.get("status", {}).get("short", "NS"),
            "elapsed": fixture.get("status", {}).get("elapsed"),
        },
        "league": {
            "id": league.get("id"),
            "name": league.get("name"),
            "season": league.get("season"),
            "round": league.get("round"),
        },
        "home": {
            "id": teams.get("home", {}).get("id"),
            "name": teams.get("home", {}).get("name"),
            "logo": teams.get("home", {}).get("logo"),
        },
        "away": {
            "id": teams.get("away", {}).get("id"),
            "name": teams.get("away", {}).get("name"),
            "logo": teams.get("away", {}).get("logo"),
        },
        "score": {
            "home": goals.get("home"),
            "away": goals.get("away"),
        },
        "lifecycle_phase": DISCOVERY,
        "last_updated": datetime.now(timezone.utc),
    }


def parse_team_form(raw_fixtures: list, team_id: int) -> tuple[list[dict], list[dict]]:
    """Extract form results and per-match stats for a team from fixture list.

    Returns (form_results, form_stats) suitable for enricher functions.
    """
    form_results = []
    form_stats = []

    for fix in raw_fixtures:
        fixture = fix.get("fixture", {})
        teams = fix.get("teams", {})
        goals = fix.get("goals", {})
        stats_list = fix.get("statistics", [])

        home_team = teams.get("home", {})
        away_team = teams.get("away", {})
        is_home = home_team.get("id") == team_id

        if is_home:
            gf = goals.get("home") or 0
            ga = goals.get("away") or 0
            opponent = away_team.get("name", "?")
            venue = "home"
        else:
            gf = goals.get("away") or 0
            ga = goals.get("home") or 0
            opponent = home_team.get("name", "?")
            venue = "away"

        won = home_team.get("winner") if is_home else away_team.get("winner")
        result = "W" if won is True else "D" if won is None and gf == ga else "L"

        form_results.append({
            "date": fixture.get("date", ""),
            "opponent": opponent,
            "venue": venue,
            "score": f"{gf}-{ga}",
            "result": result,
            "goals_for": gf,
            "goals_against": ga,
        })

        # Extract stats for this team from statistics array
        team_stats = {}
        for stat_block in stats_list:
            if stat_block.get("team", {}).get("id") == team_id:
                for stat in stat_block.get("statistics", []):
                    key = stat.get("type", "")
                    val = stat.get("value")
                    stat_map = {
                        "Shots on Goal": "shots_on_target",
                        "Total Shots": "shots_total",
                        "Ball Possession": "possession",
                        "Corner Kicks": "corners",
                        "Fouls": "fouls",
                        "Yellow Cards": "yellow_cards",
                        "Red Cards": "red_cards",
                        "Goalkeeper Saves": "gk_saves",
                        "Total passes": "passes_total",
                        "Passes accurate": "passes_accurate",
                        "Passes %": "pass_accuracy",
                    }
                    mapped = stat_map.get(key)
                    if mapped:
                        if isinstance(val, str) and val.endswith("%"):
                            val = float(val.replace("%", ""))
                        team_stats[mapped] = val
        team_stats["goals"] = gf
        form_stats.append(team_stats)

    return form_results, form_stats


def parse_season_stats(raw_fixtures: list, team_id: int) -> dict:
    """Compute season aggregates from a team's fixture list."""
    played = won = draw = lost = gf = ga = 0

    for fix in raw_fixtures:
        teams = fix.get("teams", {})
        goals = fix.get("goals", {})
        home_team = teams.get("home", {})
        is_home = home_team.get("id") == team_id

        g_for = (goals.get("home") if is_home else goals.get("away")) or 0
        g_against = (goals.get("away") if is_home else goals.get("home")) or 0
        winner = home_team.get("winner") if is_home else teams.get("away", {}).get("winner")

        played += 1
        gf += g_for
        ga += g_against
        if winner is True:
            won += 1
        elif winner is False:
            lost += 1
        else:
            draw += 1

    return {
        "played": played,
        "won": won,
        "draw": draw,
        "lost": lost,
        "goals_for": gf,
        "goals_against": ga,
        "goal_difference": gf - ga,
    }


def parse_h2h(raw_h2h: list, home_id: int, away_id: int) -> dict:
    """Build H2H summary from raw head-to-head fixture list."""
    if not raw_h2h:
        return {"total_matches": 0}

    n = len(raw_h2h)
    home_wins = away_wins = draws = hg = ag = btts = over25 = 0
    last_5 = []

    for fix in raw_h2h:
        teams = fix.get("teams", {})
        goals = fix.get("goals", {})
        fixture = fix.get("fixture", {})

        g_home = goals.get("home") or 0
        g_away = goals.get("away") or 0
        hg += g_home
        ag += g_away

        # Determine winner relative to our home/away
        h_team_id = teams.get("home", {}).get("id")
        if h_team_id == home_id:
            if goals.get("home", 0) > goals.get("away", 0):
                home_wins += 1
            elif goals.get("away", 0) > goals.get("home", 0):
                away_wins += 1
            else:
                draws += 1
        else:
            if goals.get("away", 0) > goals.get("home", 0):
                home_wins += 1
            elif goals.get("home", 0) > goals.get("away", 0):
                away_wins += 1
            else:
                draws += 1

        if g_home > 0 and g_away > 0:
            btts += 1
        if g_home + g_away >= 3:
            over25 += 1

        if len(last_5) < 5:
            last_5.append({
                "date": fixture.get("date", ""),
                "home_team": teams.get("home", {}).get("name", ""),
                "away_team": teams.get("away", {}).get("name", ""),
                "score": f"{g_home}-{g_away}",
                "venue": fixture.get("venue", {}).get("name", ""),
            })

    return {
        "total_matches": n,
        "home_wins": home_wins,
        "away_wins": away_wins,
        "draws": draws,
        "home_goals_total": hg,
        "away_goals_total": ag,
        "avg_total_goals": round((hg + ag) / n, 2),
        "last_5": last_5,
        "btts_percentage": round(btts / n * 100, 1),
        "over_25_percentage": round(over25 / n * 100, 1),
    }


def parse_odds(raw_odds: list) -> dict | None:
    """Extract 1X2 and O/U 2.5 odds from API-Football odds response."""
    if not raw_odds:
        return None

    bookmakers = raw_odds[0].get("bookmakers", []) if raw_odds else []
    if not bookmakers:
        return None

    # Take the first bookmaker
    bets = bookmakers[0].get("bets", [])
    odds = {"last_updated": datetime.now(timezone.utc)}

    for bet in bets:
        label = bet.get("name", "")
        values = bet.get("values", [])

        if label == "Match Winner":
            for v in values:
                if v.get("value") == "Home":
                    odds["home_win"] = float(v.get("odd", 0))
                elif v.get("value") == "Draw":
                    odds["draw"] = float(v.get("odd", 0))
                elif v.get("value") == "Away":
                    odds["away_win"] = float(v.get("odd", 0))

        elif label == "Goals Over/Under" or label == "Over/Under 2.5":
            for v in values:
                val = v.get("value", "")
                if "Over" in val and "2.5" in val:
                    odds["over_25"] = float(v.get("odd", 0))
                elif "Under" in val and "2.5" in val:
                    odds["under_25"] = float(v.get("odd", 0))

        elif label == "Both Teams Score":
            for v in values:
                if v.get("value") == "Yes":
                    odds["btts_yes"] = float(v.get("odd", 0))
                elif v.get("value") == "No":
                    odds["btts_no"] = float(v.get("odd", 0))

    return odds if "home_win" in odds else None


def parse_injuries(raw_injuries: list, home_id: int) -> dict:
    """Parse injury list into home/away buckets."""
    home = []
    away = []

    for entry in raw_injuries:
        player = entry.get("player", {})
        team = entry.get("team", {})
        item = {
            "player": player.get("name", "Unknown"),
            "reason": player.get("reason", "Unknown"),
            "status": player.get("type", "Out"),
            "impact": "medium",  # default; could be refined with player stats
        }

        if team.get("id") == home_id:
            home.append(item)
        else:
            away.append(item)

    return {
        "home": home,
        "away": away,
        "home_absent_impact_score": len(home) * 0.15,
        "away_absent_impact_score": len(away) * 0.15,
        "last_updated": datetime.now(timezone.utc),
    }


def parse_live_stats(raw_stats: list) -> dict:
    """Parse live fixture statistics into home/away dicts."""
    result = {"home": {}, "away": {}, "last_updated": datetime.now(timezone.utc)}
    stat_map = {
        "Shots on Goal": "shots_on_target",
        "Total Shots": "shots_total",
        "Ball Possession": "possession",
        "Corner Kicks": "corners",
        "Fouls": "fouls",
        "Yellow Cards": "yellow_cards",
        "Red Cards": "red_cards",
        "Goalkeeper Saves": "gk_saves",
        "Total passes": "passes_total",
        "Passes accurate": "passes_accurate",
        "Passes %": "pass_accuracy",
    }

    for i, block in enumerate(raw_stats[:2]):
        side = "home" if i == 0 else "away"
        for stat in block.get("statistics", []):
            mapped = stat_map.get(stat.get("type", ""))
            if mapped:
                result[side][mapped] = stat.get("value")

    return result


# ── Phase Handlers ──


async def handle_discovery(db, api: APIFootballClient):
    """Discover upcoming fixtures and insert new ones into MongoDB."""
    logger.info("=== Discovery: scanning for upcoming fixtures ===")

    for league_id in PRIORITY_LEAGUES:
        fixtures = await api.get_next_fixtures(league_id, CURRENT_SEASON, count=10)
        if not fixtures:
            logger.info(f"  No upcoming fixtures for league {league_id}")
            continue

        for raw in fixtures:
            doc = parse_fixture(raw)
            fid = doc["fixture_id"]
            if not fid:
                continue

            existing = await db.matches.find_one({"fixture_id": fid})
            if existing:
                continue

            await db.matches.insert_one(doc)
            logger.info(f"  + Discovered: {doc['home']['name']} vs {doc['away']['name']} ({doc['date']})")

    # Enforce max tracked matches — keep closest by date
    active_count = await db.matches.count_documents(
        {"lifecycle_phase": {"$nin": [CLOSED]}}
    )
    if active_count > MAX_TRACKED_MATCHES:
        logger.info(f"  Trimming to {MAX_TRACKED_MATCHES} active matches (have {active_count})")
        active = await db.matches.find(
            {"lifecycle_phase": {"$nin": [CLOSED]}},
        ).sort("date", 1).to_list(None)

        for match in active[MAX_TRACKED_MATCHES:]:
            await db.matches.update_one(
                {"_id": match["_id"]},
                {"$set": {"lifecycle_phase": CLOSED, "last_updated": datetime.now(timezone.utc)}}
            )


async def handle_pre_match(db, api: APIFootballClient, poly: PolymarketClient, match: dict):
    """Phase 1: Collect research data — form, H2H, standings, injuries, odds, Polymarket."""
    fid = match["fixture_id"]
    home_id = match["home"]["id"]
    away_id = match["away"]["id"]
    home_name = match["home"]["name"]
    away_name = match["away"]["name"]
    league_id = match["league"]["id"]

    logger.info(f"  Pre-match enrichment: {home_name} vs {away_name}")

    updates = {}

    # Fetch data in parallel where possible
    home_fixtures, away_fixtures, h2h_raw, injuries_raw, odds_raw, predictions = await asyncio.gather(
        api.get_team_fixtures(home_id, CURRENT_SEASON, last=10, phase="pre_match"),
        api.get_team_fixtures(away_id, CURRENT_SEASON, last=10, phase="pre_match"),
        api.get_h2h(home_id, away_id, last=20, phase="pre_match"),
        api.get_injuries(fid, phase="pre_match"),
        api.get_odds(fid, phase="pre_match"),
        api.get_predictions(fid, phase="pre_match"),
    )

    # Parse team form
    home_form_results, home_form_stats = parse_team_form(home_fixtures, home_id)
    away_form_results, away_form_stats = parse_team_form(away_fixtures, away_id)

    home_momentum = score_momentum([r["result"] for r in home_form_results[:5]])
    away_momentum = score_momentum([r["result"] for r in away_form_results[:5]])

    updates["home_form"] = {
        "results": home_form_results[:5],
        "momentum": home_momentum,
    }
    updates["away_form"] = {
        "results": away_form_results[:5],
        "momentum": away_momentum,
    }

    # Season stats
    home_season = parse_season_stats(home_fixtures, home_id)
    away_season = parse_season_stats(away_fixtures, away_id)
    updates["home_season"] = home_season
    updates["away_season"] = away_season

    # H2H
    updates["h2h"] = parse_h2h(h2h_raw, home_id, away_id)

    # Injuries
    updates["injuries"] = parse_injuries(injuries_raw, home_id)

    # Odds
    odds = parse_odds(odds_raw)
    if odds:
        updates["odds"] = odds
        # Snapshot to history
        await db.odds_history.insert_one({
            "fixture_id": fid,
            "captured_at": datetime.now(timezone.utc),
            **odds,
        })

    # Polymarket (free, doesn't count against budget)
    poly_data = await poly.get_match_data(home_name, away_name)
    if poly_data:
        updates["polymarket"] = poly_data
        await db.polymarket_snapshots.insert_one({
            "fixture_id": fid,
            "captured_at": datetime.now(timezone.utc),
            **poly_data,
        })

    # ── Enrichment (no API calls) ──
    league_avg = {"avg_goals_per_game": 2.7, "avg_shots_per_game": 24}

    updates["home_betting_stats"] = compute_betting_stats(home_form_results)
    updates["away_betting_stats"] = compute_betting_stats(away_form_results)
    updates["home_tempo"] = compute_tempo(home_form_stats)
    updates["away_tempo"] = compute_tempo(away_form_stats)

    pred_home = predictions.get("predictions", {}).get("percent", {}) if predictions else {}
    updates["home_xg_proxy"] = compute_xg_proxy(
        home_season, league_avg,
        {"attack": float(pred_home.get("home", "0").replace("%", ""))} if pred_home.get("home") else None,
    )
    updates["away_xg_proxy"] = compute_xg_proxy(
        away_season, league_avg,
        {"attack": float(pred_home.get("away", "0").replace("%", ""))} if pred_home.get("away") else None,
    )

    updates["home_context"] = compute_context(home_form_results, home_season)
    updates["away_context"] = compute_context(away_form_results, away_season)

    updates["match_context"] = compute_match_context(
        updates["home_betting_stats"], updates["away_betting_stats"],
        updates["home_tempo"], updates["away_tempo"],
        league_avg,
        home_team_id=home_id, away_team_id=away_id,
        known_derbies=KNOWN_DERBIES,
    )

    # Alpha signals (need both odds and polymarket)
    if odds and poly_data:
        try:
            bm_implied = remove_vig(odds["home_win"], odds["draw"], odds["away_win"])
            poly_prices = {
                "home_win": poly_data.get("moneyline", {}).get("home_price", 0),
                "draw": 0,  # Polymarket often doesn't have draw
                "away_win": poly_data.get("moneyline", {}).get("away_price", 0),
            }
            updates["alpha_signals"] = compute_alpha(bm_implied, poly_prices)
        except (ZeroDivisionError, TypeError, KeyError):
            updates["alpha_signals"] = {}
    else:
        updates["alpha_signals"] = {}

    # Build a temporary full doc for conviction and edges
    temp_doc = {**match, **updates}
    updates["conviction"] = compute_conviction(
        updates.get("alpha_signals", {}),
        updates.get("injuries", {}),
        updates.get("h2h", {}),
        updates.get("home_context", {}),
    )
    updates["suggested_edges"] = generate_suggested_edges(temp_doc)
    updates["last_updated"] = datetime.now(timezone.utc)

    await db.matches.update_one({"fixture_id": fid}, {"$set": updates})
    logger.info(f"    Enriched with {len(updates)} fields. Conviction: {updates['conviction']}")


async def handle_pre_kickoff(db, api: APIFootballClient, poly: PolymarketClient, match: dict):
    """Phase 2: Refresh data close to kickoff — lineups, fresh odds, Polymarket."""
    fid = match["fixture_id"]
    logger.info(f"  Pre-kickoff: {match['home']['name']} vs {match['away']['name']}")

    updates = {}

    lineups, fixture_data = await asyncio.gather(
        api.get_lineups(fid, phase="pre_kickoff"),
        api.get_fixture(fid, phase="pre_kickoff"),
    )

    if lineups:
        updates["lineups"] = lineups

    if fixture_data:
        status = fixture_data.get("fixture", {}).get("status", {})
        updates["status"] = {
            "long": status.get("long"),
            "short": status.get("short", "NS"),
            "elapsed": status.get("elapsed"),
        }

    # Refresh Polymarket
    poly_data = await poly.get_match_data(match["home"]["name"], match["away"]["name"])
    if poly_data:
        updates["polymarket"] = poly_data
        await db.polymarket_snapshots.insert_one({
            "fixture_id": fid,
            "captured_at": datetime.now(timezone.utc),
            **poly_data,
        })

    updates["last_updated"] = datetime.now(timezone.utc)
    await db.matches.update_one({"fixture_id": fid}, {"$set": updates})
    logger.info(f"    Updated {len(updates)} fields")


async def handle_live(db, api: APIFootballClient, poly: PolymarketClient, match: dict):
    """Phase 3: Poll live match data."""
    fid = match["fixture_id"]
    logger.info(f"  Live poll: {match['home']['name']} vs {match['away']['name']}")

    updates = {}

    if needs_live_poll(match, LIVE_POLL_INTERVAL_SEC):
        fixture_data, stats_raw = await asyncio.gather(
            api.get_fixture(fid, phase="live"),
            api.get_fixture_statistics(fid, phase="live"),
        )

        if fixture_data:
            status = fixture_data.get("fixture", {}).get("status", {})
            goals = fixture_data.get("goals", {})
            updates["status"] = {
                "long": status.get("long"),
                "short": status.get("short"),
                "elapsed": status.get("elapsed"),
            }
            updates["score"] = {
                "home": goals.get("home"),
                "away": goals.get("away"),
            }

        if stats_raw:
            updates["match_stats"] = parse_live_stats(stats_raw)
            # Generate live insight
            temp = {**match, **updates}
            insight = generate_live_insight(temp, updates["match_stats"])
            if insight:
                updates["live_insight"] = insight
                logger.info(f"    Insight: {insight}")

    if needs_polymarket_poll(match, POLYMARKET_POLL_INTERVAL_SEC):
        poly_data = await poly.get_match_data(match["home"]["name"], match["away"]["name"])
        if poly_data:
            updates["polymarket"] = poly_data
            await db.polymarket_snapshots.insert_one({
                "fixture_id": fid,
                "captured_at": datetime.now(timezone.utc),
                **poly_data,
            })

    if updates:
        updates["last_updated"] = datetime.now(timezone.utc)
        await db.matches.update_one({"fixture_id": fid}, {"$set": updates})
        logger.info(f"    Updated {len(updates)} fields")
    else:
        logger.info(f"    No poll needed yet")


async def handle_post_match(db, api: APIFootballClient, match: dict):
    """Phase 4: Fetch final stats once."""
    fid = match["fixture_id"]
    logger.info(f"  Post-match: {match['home']['name']} vs {match['away']['name']}")

    fixture_data, stats_raw = await asyncio.gather(
        api.get_fixture(fid, phase="post_match"),
        api.get_fixture_statistics(fid, phase="post_match"),
    )

    updates = {}
    if fixture_data:
        goals = fixture_data.get("goals", {})
        updates["score"] = {"home": goals.get("home"), "away": goals.get("away")}

    if stats_raw:
        updates["match_stats"] = parse_live_stats(stats_raw)

    updates["last_updated"] = datetime.now(timezone.utc)
    await db.matches.update_one({"fixture_id": fid}, {"$set": updates})
    logger.info(f"    Final stats captured")


# ── Main Scheduler Loop ──


async def run_cycle():
    """One full scheduler cycle: check all tracked matches and act on their phase."""
    try:
        db = await get_db()
        api = APIFootballClient(db)
        poly = PolymarketClient()
        tracker = BudgetTracker(db)

        budget = await tracker.get_status()
        logger.info(f"Budget: {budget['used']}/{budget['limit']} used ({budget['remaining']} remaining)")

        # 1. Discovery — find new fixtures
        await handle_discovery(db, api)

        # 2. Process each active match
        active_matches = await db.matches.find(
            {"lifecycle_phase": {"$nin": [CLOSED]}}
        ).sort("date", 1).to_list(None)

        logger.info(f"Active matches: {len(active_matches)}")

        for match in active_matches:
            # Check phase transition
            do_transition, new_phase = should_transition(match)
            if do_transition:
                old_phase = match.get("lifecycle_phase", "?")
                logger.info(f"  Transition: {match['home']['name']} vs {match['away']['name']} "
                            f"{old_phase} → {new_phase}")
                await db.matches.update_one(
                    {"fixture_id": match["fixture_id"]},
                    {"$set": {"lifecycle_phase": new_phase, "last_updated": datetime.now(timezone.utc)}}
                )
                match["lifecycle_phase"] = new_phase

            phase = match["lifecycle_phase"]

            # Check budget before API-heavy phases
            if not await tracker.can_make_request() and phase in (PRE_MATCH, PRE_KICKOFF, LIVE, POST_MATCH):
                logger.warning(f"  Budget exhausted — skipping {phase} for {match['home']['name']}")
                continue

            if phase == PRE_MATCH:
                # Only enrich once (check if already enriched)
                if not match.get("home_form"):
                    await handle_pre_match(db, api, poly, match)
                else:
                    logger.info(f"  Pre-match already enriched: {match['home']['name']} vs {match['away']['name']}")

            elif phase == PRE_KICKOFF:
                await handle_pre_kickoff(db, api, poly, match)

            elif phase == LIVE:
                await handle_live(db, api, poly, match)

            elif phase == POST_MATCH:
                if not match.get("match_stats", {}).get("last_updated"):
                    await handle_post_match(db, api, match)
                else:
                    # Already got final stats — close it
                    await db.matches.update_one(
                        {"fixture_id": match["fixture_id"]},
                        {"$set": {"lifecycle_phase": CLOSED, "last_updated": datetime.now(timezone.utc)}}
                    )
                    logger.info(f"  Closed: {match['home']['name']} vs {match['away']['name']}")

        await api.close()
        await poly.close()
        logger.info("=== Cycle complete ===\n")

    except Exception as e:
        logger.exception(f"Cycle error: {e}")


# ── FastAPI App ──


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown."""
    db = await get_db()
    await ensure_indexes(db)
    logger.info("Starting scheduler...")
    scheduler.add_job(
        run_cycle, "interval",
        seconds=SCHEDULER_CHECK_INTERVAL_SEC,
        id="main_cycle",
        next_run_time=datetime.now(timezone.utc),  # run immediately on startup
    )
    scheduler.start()
    yield
    scheduler.shutdown()
    await close_db()
    logger.info("Shutdown complete")


app = FastAPI(title="Sports Indexer", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/budget")
async def budget():
    db = await get_db()
    tracker = BudgetTracker(db)
    return await tracker.get_status()


@app.get("/matches")
async def list_matches():
    db = await get_db()
    matches = await db.matches.find(
        {"lifecycle_phase": {"$ne": CLOSED}},
        {"_id": 0},
    ).sort("date", 1).to_list(None)
    return {"count": len(matches), "matches": matches}


@app.get("/matches/{fixture_id}")
async def get_match(fixture_id: int):
    db = await get_db()
    match = await db.matches.find_one({"fixture_id": fixture_id}, {"_id": 0})
    if not match:
        return {"error": "Not found"}
    return match


@app.post("/run-cycle")
async def trigger_cycle():
    """Manually trigger a cycle (for testing)."""
    await run_cycle()
    return {"status": "cycle complete"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
