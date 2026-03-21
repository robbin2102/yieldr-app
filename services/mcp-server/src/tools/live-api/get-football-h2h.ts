/**
 * Get Football Head-to-Head
 * Returns last N H2H meetings between two teams with scores and stats.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getFootballH2HSchema = z.object({
  team_a: z.number().describe('First team ID (from search_football_fixtures)'),
  team_b: z.number().describe('Second team ID (from search_football_fixtures)'),
  last: z.number().optional().default(10).describe('Number of recent H2H meetings to return (default: 10, max: 20)'),
});

export type GetFootballH2HInput = z.infer<typeof getFootballH2HSchema>;

export async function executeGetFootballH2H(input: GetFootballH2HInput) {
  const { team_a, team_b, last = 10 } = input;
  const effectiveLast = Math.min(last, 20);

  const res = await apiFootballGet<any[]>('fixtures/headtohead', {
    h2h: `${team_a}-${team_b}`,
    last: effectiveLast,
  });

  if (!res.ok || !res.data?.length) {
    return { found: false, team_a, team_b, errors: res.errors || ['No H2H data found'] };
  }

  const matches = res.data;

  // Compute summary stats
  let aWins = 0, bWins = 0, draws = 0;
  let aGoals = 0, bGoals = 0;
  let bttsCount = 0, over25Count = 0;

  const history = matches.map((f: any) => {
    const homeId = f.teams?.home?.id;
    const homeGoals = f.goals?.home ?? 0;
    const awayGoals = f.goals?.away ?? 0;
    const totalGoals = homeGoals + awayGoals;

    // Track stats relative to team_a
    const aIsHome = homeId === team_a;
    const aG = aIsHome ? homeGoals : awayGoals;
    const bG = aIsHome ? awayGoals : homeGoals;

    aGoals += aG;
    bGoals += bG;
    if (aG > bG) aWins++;
    else if (bG > aG) bWins++;
    else draws++;
    if (homeGoals > 0 && awayGoals > 0) bttsCount++;
    if (totalGoals > 2.5) over25Count++;

    return {
      date: f.fixture?.date?.slice(0, 10),
      venue: f.fixture?.venue?.name,
      home: f.teams?.home?.name,
      away: f.teams?.away?.name,
      score: `${homeGoals}-${awayGoals}`,
      result_for_team_a: aG > bG ? 'W' : bG > aG ? 'L' : 'D',
    };
  });

  const total = matches.length;
  const teamAName = matches[0]?.teams?.home?.id === team_a
    ? matches[0]?.teams?.home?.name
    : matches[0]?.teams?.away?.name;
  const teamBName = matches[0]?.teams?.home?.id === team_b
    ? matches[0]?.teams?.home?.name
    : matches[0]?.teams?.away?.name;

  return {
    found: true,
    team_a: { id: team_a, name: teamAName },
    team_b: { id: team_b, name: teamBName },
    summary: {
      total_matches: total,
      team_a_wins: aWins,
      team_b_wins: bWins,
      draws,
      team_a_goals: aGoals,
      team_b_goals: bGoals,
      avg_total_goals: +(((aGoals + bGoals) / total).toFixed(2)),
      btts_pct: +((bttsCount / total * 100).toFixed(1)),
      over_25_pct: +((over25Count / total * 100).toFixed(1)),
    },
    matches: history,
  };
}

export const getFootballH2HTool = {
  name: 'get_football_h2h',
  description:
    'Get head-to-head history between two football teams. Returns last N meetings with scores, ' +
    'plus summary stats: wins/draws/losses, total goals, BTTS%, over 2.5%. ' +
    'Requires team IDs from search_football_fixtures.',
  inputSchema: getFootballH2HSchema,
  execute: executeGetFootballH2H,
};
