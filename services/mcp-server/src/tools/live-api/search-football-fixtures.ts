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

async function resolveTeamId(teamName: string): Promise<{ id: number; name: string } | null> {
  const res = await apiFootballGet<any[]>('teams', { search: teamName });
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
    // Default to current season if league is provided but no season
    if (league && !season && !date) params.season = new Date().getFullYear();
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
