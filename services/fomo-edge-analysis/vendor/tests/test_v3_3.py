from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fomo_analysis.action_analysis import EconomicAction
from fomo_analysis.v3_2_pattern_engine import PatternSpec
from fomo_analysis.v3_3_economics import attribute_realized_action_economics
from fomo_analysis.v3_3_pattern_engine import run_v3_3_pattern_engine, validate_pattern_v3_3
from fomo_analysis.v3_3_stories import build_v3_3_action_assessments, build_v3_3_position_stories


TRADER="evm:target|solana:target"


def action(index, side, quantity, notional, at, kind, episode="position"):
    return EconomicAction(f"a{index}",TRADER,"wallet","base","token","TOK",f"tx{index}",at,kind,side,Decimal(quantity),Decimal(notional),Decimal(notional)/Decimal(quantity),episode,(f"trade{index}",),"verified_purchase" if side=="BUY" else None,"known" if side=="BUY" else None)


def test_fifo_purchase_to_disposal_tracks_partial_and_completed_lots():
    at=datetime(2026,1,1,tzinfo=timezone.utc)
    rows=[action(1,"BUY","10","100",at,"opening_buy"),action(2,"BUY","10","200",at+timedelta(minutes=1),"addition"),action(3,"SELL","15","450",at+timedelta(minutes=2),"partial_sell"),action(4,"SELL","5","100",at+timedelta(minutes=3),"full_exit")]
    result=attribute_realized_action_economics(rows)
    assert result["a1"]["realization_status"]=="completed"
    assert Decimal(result["a1"]["realized_pnl_usd"])==Decimal("200")
    assert result["a2"]["realization_status"]=="completed"
    assert Decimal(result["a2"]["realized_pnl_usd"])==Decimal("50")
    assert Decimal(result["a3"]["realized_pnl_usd"])==Decimal("250")
    assert result["a3"]["source_acquisition_lots"]==[{"acquisition_action_id":"a1","quantity":"10"},{"acquisition_action_id":"a2","quantity":"5"}]


def test_disposal_of_pre_window_inventory_is_not_reported_as_realized():
    at=datetime(2026,1,1,tzinfo=timezone.utc)
    result=attribute_realized_action_economics([
        action(1,"SELL","10","100",at,"partial_sell"),
    ])
    assert result["a1"]["realization_status"]=="unavailable_opening_inventory_cost_basis"
    assert result["a1"]["realized_pnl_usd"] is None


def test_asymmetric_edge_does_not_require_majority_wins_or_positive_median():
    spec=PatternSpec("asym","Asymmetric","payoff","Measured condition",lambda r:r["match"],("opening_buy",),"buy_action","verified",(),"completed acquisition return",None,"token_week","fifo")
    start=datetime(2026,1,1,tzinfo=timezone.utc);rows=[]
    for index in range(800):
        matched=index%2==0; occurrence=index//2
        value=(100 if occurrence%5 in {0,1} else -20) if matched else 5
        rows.append({"action_id":str(index),"action_type":"opening_buy","timestamp":start+timedelta(days=index),"chain":"base","token_address":f"token-{occurrence%10}","episode_id":f"p-{index}","match":matched,"realized_economic_outcome":{"is_completed_observation":True,"realized_return_pct":value,"realized_pnl_usd":value,"realized_cost_basis_usd":100}})
    result=validate_pattern_v3_3(spec,rows)
    evidence=result["historical_evidence"]
    assert evidence["win_rate_percent"]==40
    assert evidence["median_realized_return_pct"]==-20
    assert evidence["realized_expectancy_pct"]>0
    assert result["payoff_shape"]["asymmetric_positive_edge"] is True
    assert "win_rate_above_50_percent" not in result["checks"]
    assert "positive_median_return" not in result["checks"]
    assert result["finding_status"]=="validated_positive_edge"


def test_assessment_and_story_separate_historical_evidence_from_actual_result():
    at=datetime(2026,1,1,tzinfo=timezone.utc)
    actions=[{"action_id":"a1","trader_id":TRADER,"wallet":"wallet","chain":"base","token_address":"token","token_symbol":"TOK","episode_id":"position","action_type":"opening_buy","side":"BUY","timestamp":at.isoformat(),"usd_notional":"100","token_amount":"10","near_rolling_high_60m":True,"realized_economic_outcome":{"realization_status":"completed","is_completed_observation":True,"realized_return_pct":"25","realized_pnl_usd":"25","realized_cost_basis_usd":"100","completed_at":(at+timedelta(days=1)).isoformat()},"timing_diagnostic_1h":{"price_return_pct":3}}]
    pattern={"key":"breakout_buyer","name":"Breakout Buyer","description":"unsafe claim","finding_status":"observed_behavior","direction":"positive_edge","required_features":["near_rolling_high_60m"],"historical_evidence":{"win_rate_percent":60,"realized_expectancy_pct":10}}
    assessments=build_v3_3_action_assessments(TRADER,actions,[pattern],assessed_at=at+timedelta(days=2))
    assert "matched Breakout Buyer" in assessments[0]["plain_english_assessment"]
    assert "observed behavior" in assessments[0]["plain_english_assessment"]
    assert assessments[0]["primary_pattern_context"]["pattern_key"] == "breakout_buyer"
    assert assessments[0]["matched_patterns"][0]["plain_english_behavior"]=="Bought near the recent one-hour high."
    assert assessments[0]["historical_numbers_are_predictions"] is False
    stories=build_v3_3_position_stories(actions,assessments)
    assert stories[0]["position_state"]=="open"
    assert stories[0]["chapters"][0]["assessment_id"]==assessments[0]["assessment_id"]
    assert "fully disposed" in stories[0]["chapters"][0]["actual_progress"]["plain_english"]


def test_position_pattern_becomes_visible_at_the_recognition_action():
    at=datetime(2026,1,1,tzinfo=timezone.utc)
    actions=[
        {"action_id":"a1","trader_id":TRADER,"wallet":"wallet","chain":"base","token_address":"token","token_symbol":"TOK","episode_id":"position","action_type":"opening_buy","side":"BUY","timestamp":at.isoformat(),"usd_notional":"100","token_amount":"10","realized_economic_outcome":{}},
        {"action_id":"a2","trader_id":TRADER,"wallet":"wallet","chain":"base","token_address":"token","token_symbol":"TOK","episode_id":"position","action_type":"partial_sell","side":"SELL","timestamp":(at+timedelta(minutes=1)).isoformat(),"usd_notional":"60","token_amount":"4","realized_economic_outcome":{}},
        {"action_id":"a3","trader_id":TRADER,"wallet":"wallet","chain":"base","token_address":"token","token_symbol":"TOK","episode_id":"position","action_type":"partial_sell","side":"SELL","timestamp":(at+timedelta(minutes=2)).isoformat(),"usd_notional":"60","token_amount":"4","realized_economic_outcome":{}},
    ]
    assessments=build_v3_3_action_assessments(TRADER,actions,[],assessed_at=at)
    episode={"episode_id":"position","sell_count":2,"opened_at":at.isoformat()}
    pattern={"key":"scaled_exiter","name":"Scaled Exiter","description":"Sells in stages.","source_dataset":"episode","finding_status":"validated_positive_edge","historical_evidence":{"completed_observation_count":50,"win_rate_percent":60,"realized_expectancy_pct":8,"realized_pnl_usd":1000}}
    stories=build_v3_3_position_stories(actions,assessments,[episode],[pattern])
    event=stories[0]["chapters"][2]["position_pattern_events"][0]
    assert event["pattern_key"] == "scaled_exiter"
    assert event["recognized_chapter_number"] == 3
    assert "first made the Scaled Exiter" in stories[0]["chapters"][2]["pattern_assessment"]


def test_trader_period_asymmetry_uses_capital_weighted_economics_not_majority_wins():
    start=datetime(2026,1,1,tzinfo=timezone.utc)
    episodes=[]
    for index in range(30):
        win=index<9
        episodes.append({
            "episode_id":f"p{index}", "opened_at":(start+timedelta(days=index)).isoformat(),
            "chain":"base", "token_address":f"t{index}",
            "roi_pct":80 if win else -20,
            "realized_pnl_usd":800 if win else -100,
            "capital_deployed_usd":1000 if win else 500,
            "time_to_full_exit_minutes":800 if win else 100,
        })
    economics={
        "average_win_pct":80, "average_loss_pct":-20, "payoff_ratio":4,
        "profit_factor":3.4, "entry_size_coefficient_of_variation":1,
        "capital_turnover":4, "realized_yield_on_deployed_capital_pct":25,
        "best_trade_profit_share":.12, "top_3_profit_share":.33, "token_profit_hhi":.05,
    }
    result=run_v3_3_pattern_engine([],episodes,economics)
    asym=next(row for row in result["patterns"] if row["key"]=="asymmetric_winner")
    assert asym["finding_status"]=="candidate_under_review"
    assert asym["historical_evidence"]["win_rate_percent"]==30
    assert asym["historical_evidence"]["median_realized_return_pct"]==-20
    assert asym["historical_evidence"]["realized_pnl_usd"]>0
    assert asym["publication"]["is_validated_edge"] is False
