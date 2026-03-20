"""Pydantic models for sports indexer data."""

from __future__ import annotations
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class TeamRecord(BaseModel):
    played: int = 0
    won: int = 0
    draw: int = 0
    lost: int = 0
    gf: int = 0
    ga: int = 0


class TeamSeason(BaseModel):
    played: int = 0
    won: int = 0
    draw: int = 0
    lost: int = 0
    goals_for: int = 0
    goals_against: int = 0
    goal_difference: int = 0
    home_record: TeamRecord = Field(default_factory=TeamRecord)
    away_record: TeamRecord = Field(default_factory=TeamRecord)
    avg_goals_scored_home: float = 0
    avg_goals_conceded_home: float = 0
    clean_sheets_home: int = 0
    failed_to_score_home: int = 0


class FormResult(BaseModel):
    date: str
    opponent: str
    venue: str
    score: str
    result: str  # W/D/L
    goals_for: int
    goals_against: int


class TeamForm(BaseModel):
    results: list[FormResult] = Field(default_factory=list)
    last5_gf: int = 0
    last5_ga: int = 0
    last5_avg_gf: float = 0
    last5_avg_ga: float = 0
    last5_points: int = 0
    momentum: str = "steady"


class InjuryEntry(BaseModel):
    player: str
    reason: str
    status: str  # Out / Doubtful / Questionable
    impact: str = "low"  # high / medium / low
    goals_per_90: float = 0
    assists_per_90: float = 0


class Injuries(BaseModel):
    home: list[InjuryEntry] = Field(default_factory=list)
    away: list[InjuryEntry] = Field(default_factory=list)
    home_absent_impact_score: float = 0
    away_absent_impact_score: float = 0
    last_updated: Optional[datetime] = None


class MatchStats(BaseModel):
    shots_total: Optional[int] = None
    shots_on_target: Optional[int] = None
    shots_off_target: Optional[int] = None
    shots_blocked: Optional[int] = None
    shots_inside_box: Optional[int] = None
    shots_outside_box: Optional[int] = None
    possession: Optional[str] = None
    passes_total: Optional[int] = None
    passes_accurate: Optional[int] = None
    pass_accuracy: Optional[str] = None
    corners: Optional[int] = None
    offsides: Optional[int] = None
    fouls: Optional[int] = None
    yellow_cards: Optional[int] = None
    red_cards: Optional[int] = None
    gk_saves: Optional[int] = None


class H2HRecord(BaseModel):
    date: str
    home_team: str
    away_team: str
    score: str
    venue: str


class H2H(BaseModel):
    total_matches: int = 0
    home_wins: int = 0
    away_wins: int = 0
    draws: int = 0
    home_goals_total: int = 0
    away_goals_total: int = 0
    avg_total_goals: float = 0
    last_5: list[H2HRecord] = Field(default_factory=list)
    home_venue_record: dict = Field(default_factory=dict)
    btts_percentage: float = 0
    over_25_percentage: float = 0
    avg_cards_in_h2h: float = 0
    avg_corners_in_h2h: float = 0


class OddsData(BaseModel):
    home_win: Optional[float] = None
    draw: Optional[float] = None
    away_win: Optional[float] = None
    over_25: Optional[float] = None
    under_25: Optional[float] = None
    btts_yes: Optional[float] = None
    btts_no: Optional[float] = None
    last_updated: Optional[datetime] = None


class PolymarketData(BaseModel):
    market_id: Optional[str] = None
    slug: Optional[str] = None
    home_price: Optional[float] = None
    draw_price: Optional[float] = None
    away_price: Optional[float] = None
    volume: Optional[float] = None
    last_updated: Optional[datetime] = None


class StandingsEntry(BaseModel):
    position: int
    team_id: int
    team_name: str
    played: int = 0
    won: int = 0
    draw: int = 0
    lost: int = 0
    goals_for: int = 0
    goals_against: int = 0
    points: int = 0
    form: str = ""
    home: TeamRecord = Field(default_factory=TeamRecord)
    away: TeamRecord = Field(default_factory=TeamRecord)


class RequestLogEntry(BaseModel):
    timestamp: datetime
    endpoint: str
    params: dict = Field(default_factory=dict)
    source: str = "indexer"
    phase: str = ""
    status_code: int = 200
    daily_count: int = 0
