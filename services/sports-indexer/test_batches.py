"""Quick validation tests for Batch 1, 2, 3 modules — no live APIs or DB needed."""

import sys
import os
import unittest.mock

# Add src to path
sys.path.insert(0, os.path.dirname(__file__))

# Pre-mock motor/pymongo to avoid cffi crash in sandbox environments
_mock_motor = unittest.mock.MagicMock()
sys.modules['pymongo'] = _mock_motor
sys.modules['pymongo.errors'] = _mock_motor
sys.modules['motor'] = _mock_motor
sys.modules['motor.motor_asyncio'] = _mock_motor

errors = []
passed = []

def test(name, fn):
    try:
        fn()
        passed.append(name)
        print(f"  PASS  {name}")
    except Exception as e:
        errors.append((name, e))
        print(f"  FAIL  {name}: {e}")

# ============================================================
# BATCH 1: Config, DB schemas
# ============================================================
print("\n=== BATCH 1: Config, DB, Schemas ===")

def test_config_imports():
    from src.config import (
        API_FOOTBALL_BASE_URL, MONGODB_DB, POLYMARKET_CLOB_URL,
        PRIORITY_LEAGUES, CURRENT_SEASON, MAX_TRACKED_MATCHES,
        DAILY_API_LIMIT, AGENT_RESERVE, INDEXER_LIMIT, KNOWN_DERBIES,
    )
    assert API_FOOTBALL_BASE_URL == "https://v3.football.api-sports.io"
    assert MONGODB_DB == "yieldr_sports"
    assert PRIORITY_LEAGUES == [39]
    assert INDEXER_LIMIT == 80  # 95 - 15
    assert isinstance(KNOWN_DERBIES, dict)

test("config imports & defaults", test_config_imports)

def test_schemas():
    from src.db.schemas import (
        TeamSeason, TeamForm, FormResult, InjuryEntry, Injuries,
        MatchStats, H2H, H2HRecord, OddsData, PolymarketData,
        StandingsEntry, RequestLogEntry,
    )
    # Test TeamSeason defaults
    ts = TeamSeason()
    assert ts.played == 0
    assert ts.goals_for == 0

    # Test FormResult creation
    fr = FormResult(
        date="2026-03-15", opponent="Chelsea", venue="home",
        score="2-1", result="W", goals_for=2, goals_against=1,
    )
    assert fr.result == "W"
    assert fr.goals_for == 2

    # Test InjuryEntry
    inj = InjuryEntry(player="Saka", reason="Hamstring", status="Out", impact="high")
    assert inj.impact == "high"

    # Test MatchStats defaults (all None)
    ms = MatchStats()
    assert ms.shots_total is None
    assert ms.possession is None

    # Test StandingsEntry
    se = StandingsEntry(position=1, team_id=50, team_name="Man City", points=65)
    assert se.team_name == "Man City"

    # Test model serialization
    data = fr.model_dump()
    assert data["opponent"] == "Chelsea"

test("schemas creation & defaults", test_schemas)

def test_db_module_import():
    try:
        from src.db.mongo import get_db, close_db, ensure_indexes
        import asyncio
        assert asyncio.iscoroutinefunction(get_db)
        assert asyncio.iscoroutinefunction(close_db)
        assert asyncio.iscoroutinefunction(ensure_indexes)
    except ImportError as e:
        # motor/pymongo may not load in sandbox (cffi issue) — skip gracefully
        print(f"    (skipped — motor import issue in sandbox: {e})")

test("db module imports", test_db_module_import)


# ============================================================
# BATCH 2: API-Football, Polymarket, Budget
# ============================================================
print("\n=== BATCH 2: API Clients, Budget ===")

def test_api_football_import():
    # Patch motor before importing api_football (which imports budget → db)
    import unittest.mock
    import sys
    sys.modules.setdefault('motor', unittest.mock.MagicMock())
    sys.modules.setdefault('motor.motor_asyncio', unittest.mock.MagicMock())
    from src.indexer.api_football import APIFootballClient
    # Verify class has all expected methods
    methods = [
        'get_fixtures_by_date', 'get_fixtures_by_round', 'get_next_fixtures',
        'get_standings', 'get_team_fixtures', 'get_h2h', 'get_injuries',
        'get_predictions', 'get_odds', 'get_lineups',
        'get_fixture_statistics', 'get_fixture',
    ]
    for m in methods:
        assert hasattr(APIFootballClient, m), f"Missing method: {m}"

test("api_football client methods", test_api_football_import)

def test_polymarket_client():
    from src.indexer.polymarket import PolymarketClient
    client = PolymarketClient()

    # Test find_best_match
    events = [
        {"title": "Arsenal vs Manchester United - EPL", "id": "123"},
        {"title": "Chelsea vs Liverpool", "id": "456"},
    ]
    best = client.find_best_match(events, "Arsenal", "Manchester United")
    assert best is not None
    assert best["id"] == "123"

    # No match
    none_result = client.find_best_match(events, "Barcelona", "Real Madrid")
    assert none_result is None

    # Test extract_prices with mock event
    mock_event = {
        "id": "test-123",
        "slug": "arsenal-vs-man-utd",
        "markets": [
            {
                "question": "Who will win?",
                "outcomes": ["Home", "Away"],
                "outcomePrices": ["0.62", "0.38"],
                "volume": "50000",
            },
            {
                "question": "Over 2.5 total goals?",
                "outcomes": ["Over", "Under"],
                "outcomePrices": ["0.58", "0.42"],
                "volume": "20000",
            },
        ],
    }
    prices = client.extract_prices(mock_event)
    assert prices["market_id"] == "test-123"
    assert prices["moneyline"]["home_price"] == 0.62
    assert prices["totals"]["over_25_price"] == 0.58
    assert prices["volume"] == 70000.0

test("polymarket client logic", test_polymarket_client)

def test_budget_import():
    from src.indexer.budget import BudgetTracker
    import asyncio
    assert asyncio.iscoroutinefunction(BudgetTracker.get_today_count)
    assert asyncio.iscoroutinefunction(BudgetTracker.can_make_request)
    assert asyncio.iscoroutinefunction(BudgetTracker.remaining)

test("budget tracker imports", test_budget_import)


# ============================================================
# BATCH 3: Enricher, Lifecycle
# ============================================================
print("\n=== BATCH 3: Enricher, Lifecycle ===")

def test_betting_stats():
    from src.indexer.enricher import compute_betting_stats
    results = [
        {"goals_for": 2, "goals_against": 1, "venue": "home"},
        {"goals_for": 0, "goals_against": 0, "venue": "home"},
        {"goals_for": 3, "goals_against": 2, "venue": "away"},
        {"goals_for": 1, "goals_against": 0, "venue": "home"},
        {"goals_for": 2, "goals_against": 2, "venue": "away"},
    ]
    stats = compute_betting_stats(results)
    assert stats["btts_pct"] == 60.0   # 3/5 (matches 1,3,5)
    assert stats["over_25_pct"] == 60.0  # 3/5 (totals: 3,5,4 >= 3)
    assert stats["clean_sheet_pct"] == 40.0  # 2/5 (matches 2,4: 0-0 and 1-0)
    assert stats["failed_to_score_pct"] == 20.0  # 1/5 (match 2: 0-0)

    # Filter by venue — home matches: (2,1), (0,0), (1,0)
    home_stats = compute_betting_stats(results, venue_filter="home")
    assert len([r for r in results if r["venue"] == "home"]) == 3
    assert home_stats["clean_sheet_pct"] == 66.7  # 2/3 (0-0 and 1-0)

    # Empty input
    assert compute_betting_stats([]) == {}

test("enricher: betting stats", test_betting_stats)

def test_tempo():
    from src.indexer.enricher import compute_tempo
    stats = [
        {"shots_total": 15, "shots_on_target": 6, "possession": 62, "corners": 7, "fouls": 10, "yellow_cards": 2, "goals": 2},
        {"shots_total": 12, "shots_on_target": 4, "possession": 58, "corners": 5, "fouls": 12, "yellow_cards": 1, "goals": 1},
    ]
    tempo = compute_tempo(stats)
    assert tempo["avg_shots_per_game"] == 13.5
    assert tempo["avg_possession"] == 60.0
    assert "shot_conversion_rate" in tempo
    assert tempo["shot_conversion_rate"] == round(3 / 27, 3)

    assert compute_tempo([]) == {}

test("enricher: tempo", test_tempo)

def test_xg_proxy():
    from src.indexer.enricher import compute_xg_proxy
    season = {"played": 29, "goals_for": 58, "goals_against": 22}
    league = {"avg_goals_per_game": 2.7}
    pred = {"attack": 85, "defense": 80}
    xg = compute_xg_proxy(season, league, pred)
    assert xg["attacking_index"] > 1.0  # 58/29 = 2.0 vs 1.35 league avg per team
    assert xg["defensive_index"] < 1.0  # 22/29 = 0.76 vs 1.35
    assert xg["attack_strength_pct"] == 85

test("enricher: xG proxy", test_xg_proxy)

def test_context():
    from src.indexer.enricher import compute_context
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    results = [
        {"goals_for": 3, "goals_against": 1, "date": (now - timedelta(days=3)).isoformat()},
        {"goals_for": 2, "goals_against": 0, "date": (now - timedelta(days=7)).isoformat()},
        {"goals_for": 1, "goals_against": 1, "date": (now - timedelta(days=10)).isoformat()},
        {"goals_for": 0, "goals_against": 2, "date": (now - timedelta(days=15)).isoformat()},
    ]
    season = {"played": 29, "goals_for": 45}
    ctx = compute_context(results, season)
    assert ctx["days_since_last_match"] == 3
    assert ctx["matches_last_14_days"] == 3
    assert ctx["is_congested"] == True

test("enricher: context", test_context)

def test_momentum():
    from src.indexer.enricher import score_momentum
    assert score_momentum(["W", "W", "W", "W", "W"]) == "strong"  # 15pts
    assert score_momentum(["W", "W", "D", "W", "L"]) == "steady"   # 10pts
    assert score_momentum(["W", "D", "L", "L", "L"]) == "declining" # 4pts
    assert score_momentum(["L", "L", "L", "L", "L"]) == "poor"     # 0pts

test("enricher: momentum", test_momentum)

def test_referee_profile():
    from src.indexer.enricher import compute_referee_profile
    fixtures = [
        {"referee": "Michael Oliver", "match_stats": {"home": {"yellow_cards": 3}, "away": {"yellow_cards": 2}}},
        {"referee": "Michael Oliver", "match_stats": {"home": {"yellow_cards": 2}, "away": {"yellow_cards": 1}}},
        {"referee": "Anthony Taylor", "match_stats": {"home": {"yellow_cards": 1}, "away": {"yellow_cards": 1}}},
    ]
    profile = compute_referee_profile("Michael Oliver", fixtures, 3.2)
    assert profile["name"] == "Michael Oliver"
    assert profile["games_in_dataset"] == 2
    assert profile["avg_yellow_cards_per_game"] == 4.0  # (5+3)/2
    assert profile["card_tendency"] == "strict"  # 4.0 > 3.2 * 1.15

    # Unknown ref
    unknown = compute_referee_profile("Nobody", fixtures, 3.2)
    assert unknown["games_in_dataset"] == 0

test("enricher: referee profile", test_referee_profile)

def test_match_context():
    from src.indexer.enricher import compute_match_context
    from src.config import KNOWN_DERBIES
    ctx = compute_match_context(
        home_betting={"over_25_pct": 66.7},
        away_betting={"over_25_pct": 58.6},
        home_tempo={"avg_shots_per_game": 15.2},
        away_tempo={"avg_shots_per_game": 13.1},
        league_avg={"avg_shots_per_game": 12.0},
        home_team_id=42, away_team_id=47,
        known_derbies=KNOWN_DERBIES,
    )
    assert ctx["expected_goal_environment"] == "high"  # (66.7+58.6)/2 = 62.65 > 60
    assert ctx["is_derby"] == True  # Arsenal vs Tottenham

test("enricher: match context", test_match_context)

def test_odds_alpha():
    from src.indexer.enricher import remove_vig, compute_alpha
    implied = remove_vig(1.55, 4.20, 5.80)
    assert abs(implied["home_win"] - 0.612) < 0.01  # ~61.2%
    assert abs(implied["draw"] - 0.226) < 0.01
    assert abs(implied["away_win"] - 0.163) < 0.01

    alpha = compute_alpha(
        {"home_win": 0.612, "draw": 0.226, "away_win": 0.162},
        {"home_win": 0.58, "draw": 0.24, "away_win": 0.18},
    )
    assert "home_win" in alpha
    assert alpha["home_win"]["delta"] > 0.02
    assert "underpriced" in alpha["home_win"]["signal"].lower()

test("enricher: odds & alpha", test_odds_alpha)

def test_conviction():
    from src.indexer.enricher import compute_conviction
    alpha = {"moneyline": {"delta": 0.06}}
    injuries = {"home_absent_impact_score": 0.1, "away_absent_impact_score": 0.6}
    h2h = {"home_venue_record": {"played": 6, "home_wins": 5}}
    context = {"is_congested": True}
    result = compute_conviction(alpha, injuries, h2h, context)
    assert result == "high"  # 3 (delta>0.05) + 1 (away injury) + 1 (venue) + 1 (congestion) = 6

test("enricher: conviction", test_conviction)

def test_suggested_edges():
    from src.indexer.enricher import generate_suggested_edges
    doc = {
        "alpha_signals": {"moneyline_edge": {"signal": "Polymarket underpriced by 3.2%"}},
        "home_betting_stats": {"over_25_pct": 66.7, "btts_pct": 73.3},
        "away_betting_stats": {"over_25_pct": 58.6, "btts_pct": 62.1},
        "referee_profile": {"card_tendency": "strict", "name": "Michael Oliver", "avg_yellow_cards_per_game": 3.8},
        "away_context": {"is_congested": True, "matches_last_14_days": 4},
        "away": {"name": "Manchester United"},
    }
    edges = generate_suggested_edges(doc)
    assert len(edges) >= 4  # moneyline + over + btts + ref + congestion
    assert any("3.2%" in e for e in edges)
    assert any("BTTS" in e for e in edges)

test("enricher: suggested edges", test_suggested_edges)

def test_lifecycle_phases():
    from src.indexer.lifecycle import determine_phase, should_transition, needs_live_poll
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)

    # T-48h → discovery
    assert determine_phase({"date": (now + timedelta(hours=48)).isoformat(), "status": {"short": "NS"}}) == "discovery"

    # T-12h → pre_match
    assert determine_phase({"date": (now + timedelta(hours=12)).isoformat(), "status": {"short": "NS"}}) == "pre_match"

    # T-30min → pre_kickoff
    assert determine_phase({"date": (now + timedelta(minutes=30)).isoformat(), "status": {"short": "NS"}}) == "pre_kickoff"

    # Live status
    assert determine_phase({"date": now.isoformat(), "status": {"short": "1H"}}) == "live"
    assert determine_phase({"date": now.isoformat(), "status": {"short": "HT"}}) == "live"

    # Finished
    assert determine_phase({"date": now.isoformat(), "status": {"short": "FT"}}) == "post_match"

    # Cancelled
    assert determine_phase({"date": now.isoformat(), "status": {"short": "CANC"}}) == "closed"

test("lifecycle: phase determination", test_lifecycle_phases)

def test_lifecycle_transitions():
    from src.indexer.lifecycle import should_transition
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)

    # discovery → pre_match
    match = {
        "lifecycle_phase": "discovery",
        "date": (now + timedelta(hours=12)).isoformat(),
        "status": {"short": "NS"},
    }
    trans, new = should_transition(match)
    assert trans == True
    assert new == "pre_match"

    # Already in correct phase
    match["lifecycle_phase"] = "pre_match"
    trans, new = should_transition(match)
    assert trans == False

    # Can't go backward
    match["lifecycle_phase"] = "live"
    match["status"]["short"] = "NS"
    trans, new = should_transition(match)
    assert trans == False  # pre_match < live, no backward

test("lifecycle: transitions", test_lifecycle_transitions)

def test_live_poll():
    from src.indexer.lifecycle import needs_live_poll, needs_polymarket_poll
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)

    # Live match, no previous update
    match = {"lifecycle_phase": "live", "match_stats": {}}
    assert needs_live_poll(match) == True

    # Live match, recent update
    match["match_stats"]["last_updated"] = (now - timedelta(minutes=5)).isoformat()
    assert needs_live_poll(match) == False

    # Live match, stale update
    match["match_stats"]["last_updated"] = (now - timedelta(minutes=20)).isoformat()
    assert needs_live_poll(match) == True

    # Not live
    match["lifecycle_phase"] = "pre_match"
    assert needs_live_poll(match) == False

    # Polymarket poll
    poly_match = {"lifecycle_phase": "live", "polymarket": {}}
    assert needs_polymarket_poll(poly_match) == True

test("lifecycle: poll checks", test_live_poll)

def test_live_insight():
    from src.indexer.enricher import generate_live_insight
    match = {
        "home": {"name": "Arsenal"},
        "away": {"name": "Man Utd"},
        "score": {"home": 0, "away": 0},
        "status": {"elapsed": 55},
    }
    stats = {
        "home": {"possession": "68%", "shots_on_target": 6, "corners": 7, "yellow_cards": 3},
        "away": {"shots_on_target": 1, "corners": 4, "yellow_cards": 2},
    }
    insight = generate_live_insight(match, stats)
    assert insight is not None
    assert "Arsenal" in insight
    assert "possession" in insight.lower() or "SOT" in insight
    assert "corner" in insight.lower()
    assert "cards" in insight.lower()

test("enricher: live insights", test_live_insight)


# ============================================================
# SUMMARY
# ============================================================
print(f"\n{'='*50}")
print(f"  PASSED: {len(passed)}/{len(passed)+len(errors)}")
if errors:
    print(f"  FAILED: {len(errors)}")
    for name, err in errors:
        print(f"    - {name}: {err}")
    sys.exit(1)
else:
    print("  All tests passed!")
    sys.exit(0)
