/**
 * Search Football Fixtures
 * Find fixtures by team name, date, league, or live status.
 * Resolves fuzzy team names to team IDs via /teams endpoint.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const searchFootballFixturesSchema = z.object({
  team: z.string().optional().describe('Team name to search (e.g. "Arsenal", "Man United"). Resolved to team ID automatically.'),
  date: z.string().optional().describe('Date in YYYY-MM-DD format (e.g. "2025-12-25"). Returns all fixtures for that date.'),
  league: z.number().optional().describe('League ID (e.g. 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=Champions League, 3=Europa League)'),
  season: z.number().optional().describe('Season year (e.g. 2025). Defaults to current season.'),
  live: z.boolean().optional().describe('If true, only return currently live matches.'),
  next: z.number().optional().describe('Return next N upcoming fixtures for a team (requires team param). Max 10.'),
  last: z.number().optional().describe('Return last N completed fixtures for a team (requires team param). Max 10.'),
});

export type SearchFootballFixturesInput = z.infer<typeof searchFootballFixturesSchema>;

// Common team name aliases → full names that API-Football resolves correctly.
// Prevents wasted API calls on abbreviations the search endpoint can't fuzzy-match.
const TEAM_ALIASES: Record<string, string> = {
  'man united': 'Manchester United', 'man utd': 'Manchester United', 'mufc': 'Manchester United', 'man u': 'Manchester United',
  'man city': 'Manchester City', 'mcfc': 'Manchester City',
  'spurs': 'Tottenham Hotspur', 'tottenham': 'Tottenham Hotspur', 'thfc': 'Tottenham Hotspur',
  'chelsea': 'Chelsea', 'cfc': 'Chelsea',
  'arsenal': 'Arsenal', 'afc': 'Arsenal', 'gunners': 'Arsenal',
  'liverpool': 'Liverpool', 'lfc': 'Liverpool', 'the reds': 'Liverpool',
  'newcastle': 'Newcastle United', 'nufc': 'Newcastle United', 'toon': 'Newcastle United',
  'west ham': 'West Ham United', 'whu': 'West Ham United', 'hammers': 'West Ham United',
  'everton': 'Everton', 'efc': 'Everton', 'toffees': 'Everton',
  'aston villa': 'Aston Villa', 'avfc': 'Aston Villa', 'villa': 'Aston Villa',
  'wolves': 'Wolverhampton Wanderers', 'wolverhampton': 'Wolverhampton Wanderers',
  'leicester': 'Leicester City', 'lcfc': 'Leicester City',
  'brighton': 'Brighton And Hove Albion', 'bhafc': 'Brighton And Hove Albion',
  'barca': 'Barcelona', 'fc barcelona': 'Barcelona',
  'real': 'Real Madrid', 'real madrid': 'Real Madrid', 'rmcf': 'Real Madrid',
  'atletico': 'Atletico Madrid', 'atletico madrid': 'Atletico Madrid',
  'bayern': 'Bayern Munich', 'bayern munich': 'Bayern Munich', 'fcb': 'Bayern Munich',
  'psg': 'Paris Saint Germain', 'paris sg': 'Paris Saint Germain',
  'juve': 'Juventus', 'juventus': 'Juventus',
  'inter': 'Inter Milan', 'inter milan': 'Inter Milan', 'internazionale': 'Inter Milan',
  'ac milan': 'AC Milan', 'milan': 'AC Milan',
  'dortmund': 'Borussia Dortmund', 'bvb': 'Borussia Dortmund',
  'napoli': 'SSC Napoli',
  'benfica': 'SL Benfica',
  'porto': 'FC Porto',
  'ajax': 'Ajax',
  'celtic': 'Celtic',
  'rangers': 'Rangers',
};

async function resolveTeamId(teamName: string): Promise<{ id: number; name: string } | null> {
  const searchName = TEAM_ALIASES[teamName.toLowerCase().trim()] || teamName;
  const res = await apiFootballGet<any[]>('teams', { search: searchName });
  if (!res.ok || !res.data?.length) return null;
  // Return the best match (first result from API)
  const team = res.data[0]?.team;
  return team ? { id: team.id, name: team.name } : null;
}

export async function executeSearchFootballFixtures(input: SearchFootballFixturesInput) {
  const { team, date, league, season, live, next, last } = input;

  // Resolve team name to ID if provided
  let teamId: number | undefined;
  let resolvedTeamName: string | undefined;
  if (team) {
    const resolved = await resolveTeamId(team);
    if (!resolved) {
      return { found: false, message: `Could not find team matching "${team}". Try a more specific name.` };
    }
    teamId = resolved.id;
    resolvedTeamName = resolved.name;
  }

  // Build params based on what's provided
  const params: Record<string, string | number | undefined> = {};

  if (live) {
    params.live = 'all';
  } else if (teamId && next) {
    params.team = teamId;
    params.next = Math.min(next, 10);
  } else if (teamId && last) {
    params.team = teamId;
    params.last = Math.min(last, 10);
  } else {
    if (teamId) params.team = teamId;
    if (date) params.date = date;
    if (league) params.league = league;
    if (season) params.season = season;
    // Auto-default season when team or league is provided without season/date
    // API-Football returns empty without a season filter
    if ((teamId || league) && !season && !date) {
      const now = new Date();
      // Football seasons span two calendar years (e.g. 2024-25 season starts Aug 2024).
      // API-Football uses the start year, so before August use previous year.
      params.season = now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear();
    }
  }

  const res = await apiFootballGet<any[]>('fixtures', params);
  if (!res.ok) {
    return { found: false, errors: res.errors };
  }

  const fixtures = (res.data || []).slice(0, 20).map((f: any) => ({
    fixture_id: f.fixture?.id,
    date: f.fixture?.date,
    referee: f.fixture?.referee,
    venue: f.fixture?.venue?.name,
    city: f.fixture?.venue?.city,
    status: {
      long: f.fixture?.status?.long,
      short: f.fixture?.status?.short,
      elapsed: f.fixture?.status?.elapsed,
    },
    league: {
      id: f.league?.id,
      name: f.league?.name,
      country: f.league?.country,
      round: f.league?.round,
      season: f.league?.season,
    },
    home: {
      id: f.teams?.home?.id,
      name: f.teams?.home?.name,
      winner: f.teams?.home?.winner,
    },
    away: {
      id: f.teams?.away?.id,
      name: f.teams?.away?.name,
      winner: f.teams?.away?.winner,
    },
    score: {
      home: f.goals?.home,
      away: f.goals?.away,
      halftime: f.score?.halftime,
      fulltime: f.score?.fulltime,
    },
  }));

  return {
    found: true,
    ...(resolvedTeamName ? { resolved_team: resolvedTeamName, team_id: teamId } : {}),
    total: fixtures.length,
    fixtures,
  };
}

export const searchFootballFixturesTool = {
  name: 'search_football_fixtures',
  description:
    'Search for football/soccer fixtures by team name, date, league, or live status. ' +
    'Resolves fuzzy team names automatically (e.g. "Man Utd" → "Manchester United"). ' +
    'Use to find fixture_id for other football tools. ' +
    'Common league IDs: 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL, 3=Europa League.',
  inputSchema: searchFootballFixturesSchema,
  execute: executeSearchFootballFixtures,
};
