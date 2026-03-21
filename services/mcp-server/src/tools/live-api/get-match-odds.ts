/**
 * Get Match Odds
 * Returns bookmaker odds + API-Football predictions for a fixture.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getMatchOddsSchema = z.object({
  fixture_id: z.number().describe('Fixture ID from search_football_fixtures'),
  include_predictions: z.boolean().optional().default(true).describe('Also fetch API-Football AI predictions (default: true). Uses 1 extra API call.'),
});

export type GetMatchOddsInput = z.infer<typeof getMatchOddsSchema>;

function parseOddsFromBets(bets: any[]): Record<string, any> {
  const result: Record<string, any> = {};

  for (const bet of bets) {
    const label = bet.name as string;
    const values = (bet.values || []) as Array<{ value: string; odd: string }>;

    if (label === 'Match Winner') {
      result.match_winner = {
        home: parseFloat(values.find((v: any) => v.value === 'Home')?.odd ?? '0'),
        draw: parseFloat(values.find((v: any) => v.value === 'Draw')?.odd ?? '0'),
        away: parseFloat(values.find((v: any) => v.value === 'Away')?.odd ?? '0'),
      };
    } else if (label === 'Goals Over/Under' || label === 'Over/Under 2.5') {
      const over25 = values.find((v: any) => v.value === 'Over 2.5');
      const under25 = values.find((v: any) => v.value === 'Under 2.5');
      if (over25 || under25) {
        result.over_under_25 = {
          over: parseFloat(over25?.odd ?? '0'),
          under: parseFloat(under25?.odd ?? '0'),
        };
      }
    } else if (label === 'Both Teams Score') {
      result.btts = {
        yes: parseFloat(values.find((v: any) => v.value === 'Yes')?.odd ?? '0'),
        no: parseFloat(values.find((v: any) => v.value === 'No')?.odd ?? '0'),
      };
    } else if (label === 'Double Chance') {
      result.double_chance = {
        home_draw: parseFloat(values.find((v: any) => v.value === 'Home/Draw')?.odd ?? '0'),
        home_away: parseFloat(values.find((v: any) => v.value === 'Home/Away')?.odd ?? '0'),
        draw_away: parseFloat(values.find((v: any) => v.value === 'Draw/Away')?.odd ?? '0'),
      };
    }
  }
  return result;
}

export async function executeGetMatchOdds(input: GetMatchOddsInput) {
  const { fixture_id, include_predictions = true } = input;

  // Fetch odds and predictions in parallel
  const [oddsRes, predRes] = await Promise.all([
    apiFootballGet<any[]>('odds', { fixture: fixture_id }),
    include_predictions
      ? apiFootballGet<any[]>('predictions', { fixture: fixture_id })
      : Promise.resolve(null),
  ]);

  const result: Record<string, any> = { found: true, fixture_id };

  // Process odds
  if (oddsRes.ok && oddsRes.data?.length) {
    const bookmakers = oddsRes.data[0]?.bookmakers || [];
    // Use the first bookmaker with data (usually Bet365 or similar)
    const primaryBookmaker = bookmakers[0];
    if (primaryBookmaker) {
      result.bookmaker = primaryBookmaker.name;
      result.odds = parseOddsFromBets(primaryBookmaker.bets || []);

      // Also compute implied probabilities from match winner odds
      const mw = result.odds.match_winner;
      if (mw?.home && mw?.draw && mw?.away) {
        const totalImplied = 1 / mw.home + 1 / mw.draw + 1 / mw.away;
        result.implied_probability = {
          home: +((1 / mw.home / totalImplied * 100).toFixed(1)),
          draw: +((1 / mw.draw / totalImplied * 100).toFixed(1)),
          away: +((1 / mw.away / totalImplied * 100).toFixed(1)),
          overround_pct: +(((totalImplied - 1) * 100).toFixed(1)),
        };
      }
    }
  } else {
    result.odds = null;
    result.odds_note = 'Odds not yet available for this fixture (usually available 1-3 days before kickoff)';
  }

  // Process predictions
  if (predRes?.ok && predRes.data?.length) {
    const pred = predRes.data[0];
    result.predictions = {
      winner: pred.predictions?.winner?.name,
      win_or_draw: pred.predictions?.win_or_draw,
      advice: pred.predictions?.advice,
      goals: pred.predictions?.goals, // { home: "-2.5", away: "-1.5" }
      percent: pred.predictions?.percent, // { home: "60%", draw: "20%", away: "20%" }
    };

    // Comparison stats from predictions endpoint
    if (pred.comparison) {
      result.comparison = {
        form: pred.comparison.form,
        attack: pred.comparison.att,
        defense: pred.comparison.def,
        poisson: pred.comparison.poisson_distribution,
        h2h: pred.comparison.h2h,
        goals: pred.comparison.goals,
        total: pred.comparison.total,
      };
    }

    // Teams overview from predictions (useful context)
    if (pred.teams) {
      const mapTeam = (t: any) => ({
        name: t.name,
        last_5_form: t.league?.form,
        attack: t.league?.goals?.for?.average?.total,
        defense: t.league?.goals?.against?.average?.total,
        clean_sheets_pct: t.league?.clean_sheet?.total
          ? +((t.league.clean_sheet.total / (t.league.fixtures?.played?.total || 1) * 100).toFixed(1))
          : null,
      });
      result.team_overview = {
        home: pred.teams.home ? mapTeam(pred.teams.home) : null,
        away: pred.teams.away ? mapTeam(pred.teams.away) : null,
      };
    }
  }

  return result;
}

export const getMatchOddsTool = {
  name: 'get_match_odds',
  description:
    'Get bookmaker odds and API-Football AI predictions for a fixture. ' +
    'Returns 1X2 odds, Over/Under 2.5, BTTS, Double Chance, implied probabilities (vig-removed), ' +
    'AI prediction (winner, advice, goal expectations), and team comparison stats (form, attack, defense). ' +
    'Compare implied_probability with Polymarket prices to find edges.',
  inputSchema: getMatchOddsSchema,
  execute: executeGetMatchOdds,
};
