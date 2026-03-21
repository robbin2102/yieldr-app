/**
 * Get Team Form
 * Returns recent results + season statistics for a team.
 * Combines /fixtures (last N) + /teams/statistics for full picture.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getTeamFormSchema = z.object({
  team_id: z.number().describe('Team ID (from search_football_fixtures)'),
  league: z.number().optional().describe('League ID to scope season stats (e.g. 39=Premier League). Required for season stats.'),
  season: z.number().optional().describe('Season year (e.g. 2025). Defaults to current year.'),
  last: z.number().optional().default(10).describe('Number of recent fixtures to return (default: 10, max: 15)'),
});

export type GetTeamFormInput = z.infer<typeof getTeamFormSchema>;

export async function executeGetTeamForm(input: GetTeamFormInput) {
  const { team_id, league, season = new Date().getFullYear(), last = 10 } = input;
  const effectiveLast = Math.min(last, 15);

  // Fetch recent fixtures + season stats in parallel
  const [fixturesRes, seasonRes] = await Promise.all([
    apiFootballGet<any[]>('fixtures', { team: team_id, last: effectiveLast }),
    league
      ? apiFootballGet<any>('teams/statistics', { team: team_id, league, season })
      : Promise.resolve(null),
  ]);

  const result: Record<string, any> = { found: true, team_id };

  // Process recent fixtures into form data
  if (fixturesRes.ok && fixturesRes.data?.length) {
    let wins = 0, draws = 0, losses = 0;
    let goalsFor = 0, goalsAgainst = 0;
    let bttsCount = 0, over25Count = 0, cleanSheets = 0, failedToScore = 0;

    const recentForm = fixturesRes.data.map((f: any) => {
      const isHome = f.teams?.home?.id === team_id;
      const gf = isHome ? (f.goals?.home ?? 0) : (f.goals?.away ?? 0);
      const ga = isHome ? (f.goals?.away ?? 0) : (f.goals?.home ?? 0);
      const res = gf > ga ? 'W' : ga > gf ? 'L' : 'D';

      if (res === 'W') wins++;
      else if (res === 'D') draws++;
      else losses++;
      goalsFor += gf;
      goalsAgainst += ga;
      if (gf > 0 && ga > 0) bttsCount++;
      if (gf + ga > 2) over25Count++;
      if (ga === 0) cleanSheets++;
      if (gf === 0) failedToScore++;

      return {
        date: f.fixture?.date?.slice(0, 10),
        opponent: isHome ? f.teams?.away?.name : f.teams?.home?.name,
        venue: isHome ? 'home' : 'away',
        score: `${gf}-${ga}`,
        result: res,
        league: f.league?.name,
      };
    });

    const total = recentForm.length;
    const points = wins * 3 + draws;
    const maxPoints = total * 3;

    // Momentum: based on last 5 results (W=3, D=1, L=0)
    const last5 = recentForm.slice(0, 5);
    const last5Points = last5.reduce((s: number, r: any) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
    const momentum = last5Points >= 12 ? 'strong' : last5Points >= 8 ? 'steady' : last5Points >= 4 ? 'declining' : 'poor';

    result.form = {
      results: recentForm,
      form_string: recentForm.map((r: any) => r.result).join(''),
      momentum,
      stats: {
        played: total,
        won: wins,
        drawn: draws,
        lost: losses,
        points,
        points_pct: +((points / maxPoints * 100).toFixed(1)),
        goals_for: goalsFor,
        goals_against: goalsAgainst,
        avg_goals_scored: +(goalsFor / total).toFixed(2),
        avg_goals_conceded: +(goalsAgainst / total).toFixed(2),
      },
      betting_stats: {
        btts_pct: +((bttsCount / total * 100).toFixed(1)),
        over_25_pct: +((over25Count / total * 100).toFixed(1)),
        under_25_pct: +(((total - over25Count) / total * 100).toFixed(1)),
        clean_sheet_pct: +((cleanSheets / total * 100).toFixed(1)),
        failed_to_score_pct: +((failedToScore / total * 100).toFixed(1)),
        avg_total_goals: +(((goalsFor + goalsAgainst) / total).toFixed(2)),
      },
    };

    // Context: fixture congestion
    if (recentForm.length >= 2) {
      const dates = recentForm.map((r: any) => new Date(r.date).getTime());
      const daysSinceLast = Math.round((Date.now() - dates[0]) / 86400000);
      const twoWeeksAgo = Date.now() - 14 * 86400000;
      const matchesLast14Days = dates.filter(d => d >= twoWeeksAgo).length;
      result.context = {
        days_since_last_match: daysSinceLast,
        matches_last_14_days: matchesLast14Days,
        is_congested: matchesLast14Days >= 4,
      };
    }
  }

  // Process season stats
  if (seasonRes?.ok && seasonRes.data) {
    const s = seasonRes.data;
    result.team_name = s.team?.name;
    result.season_stats = {
      league: s.league?.name,
      season: s.league?.season,
      fixtures: {
        played: s.fixtures?.played?.total,
        wins: s.fixtures?.wins?.total,
        draws: s.fixtures?.draws?.total,
        losses: s.fixtures?.loses?.total,
        home: { played: s.fixtures?.played?.home, wins: s.fixtures?.wins?.home, draws: s.fixtures?.draws?.home, losses: s.fixtures?.loses?.home },
        away: { played: s.fixtures?.played?.away, wins: s.fixtures?.wins?.away, draws: s.fixtures?.draws?.away, losses: s.fixtures?.loses?.away },
      },
      goals: {
        for_total: s.goals?.for?.total?.total,
        for_avg: s.goals?.for?.average?.total,
        against_total: s.goals?.against?.total?.total,
        against_avg: s.goals?.against?.average?.total,
      },
      clean_sheets: s.clean_sheet?.total,
      failed_to_score: s.failed_to_score?.total,
      biggest: {
        wins: s.biggest?.wins,
        loses: s.biggest?.loses,
        streak: s.biggest?.streak,
      },
      form: s.form, // e.g. "WWDLWWW"
    };
  }

  return result;
}

export const getTeamFormTool = {
  name: 'get_team_form',
  description:
    'Get team form (recent results) and season statistics. Returns last N fixtures with results, ' +
    'computed betting stats (BTTS%, O2.5%, clean sheet%, failed to score%), momentum grade, ' +
    'fixture congestion context, and full season stats (if league ID provided). ' +
    'Requires team_id from search_football_fixtures.',
  inputSchema: getTeamFormSchema,
  execute: executeGetTeamForm,
};
