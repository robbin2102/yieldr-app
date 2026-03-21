/**
 * Get Football Standings
 * Returns full league table with points, form, goals, etc.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getFootballStandingsSchema = z.object({
  league: z.number().describe('League ID (e.g. 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL)'),
  season: z.number().optional().describe('Season year (e.g. 2025). Defaults to current year.'),
});

export type GetFootballStandingsInput = z.infer<typeof getFootballStandingsSchema>;

export async function executeGetFootballStandings(input: GetFootballStandingsInput) {
  const { league, season = new Date().getFullYear() } = input;

  const res = await apiFootballGet<any[]>('standings', { league, season });
  if (!res.ok || !res.data?.length) {
    return { found: false, league, season, errors: res.errors || ['No standings found'] };
  }

  const leagueData = res.data[0]?.league;
  if (!leagueData?.standings?.length) {
    return { found: false, league, season, message: 'Standings not available for this league/season' };
  }

  // Standings can have multiple groups (e.g. UCL groups)
  const groups = leagueData.standings.map((group: any[]) =>
    group.map((entry: any) => ({
      rank: entry.rank,
      team: entry.team?.name,
      team_id: entry.team?.id,
      points: entry.points,
      played: entry.all?.played,
      won: entry.all?.win,
      draw: entry.all?.draw,
      lost: entry.all?.lose,
      goals_for: entry.all?.goals?.for,
      goals_against: entry.all?.goals?.against,
      goal_difference: entry.goalsDiff,
      form: entry.form, // e.g. "WWDLW"
      home: {
        played: entry.home?.played,
        won: entry.home?.win,
        draw: entry.home?.draw,
        lost: entry.home?.lose,
        gf: entry.home?.goals?.for,
        ga: entry.home?.goals?.against,
      },
      away: {
        played: entry.away?.played,
        won: entry.away?.win,
        draw: entry.away?.draw,
        lost: entry.away?.lose,
        gf: entry.away?.goals?.for,
        ga: entry.away?.goals?.against,
      },
      description: entry.description, // e.g. "Champions League", "Relegation"
    }))
  );

  return {
    found: true,
    league: {
      id: leagueData.id,
      name: leagueData.name,
      country: leagueData.country,
      season: leagueData.season,
    },
    groups: groups.length === 1 ? undefined : groups.length,
    standings: groups.length === 1 ? groups[0] : groups,
  };
}

export const getFootballStandingsTool = {
  name: 'get_football_standings',
  description:
    'Get full league standings/table for a football league and season. ' +
    'Returns rank, points, W/D/L, goals for/against, GD, form (last 5), and home/away splits. ' +
    'Common league IDs: 39=Premier League, 140=La Liga, 135=Serie A, 78=Bundesliga, 61=Ligue 1, 2=UCL.',
  inputSchema: getFootballStandingsSchema,
  execute: executeGetFootballStandings,
};
