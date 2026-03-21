/**
 * Get Fixture Details
 * Full match data: score, status, lineups, match statistics, and events (goals/cards/subs).
 * Works for upcoming, live, and completed matches.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getFixtureDetailsSchema = z.object({
  fixture_id: z.number().describe('Fixture ID from search_football_fixtures'),
  include: z.array(z.enum(['stats', 'events', 'lineups'])).optional()
    .describe('Which extra data to include. Default: all. Use ["stats"] for stats only to save API calls.'),
});

export type GetFixtureDetailsInput = z.infer<typeof getFixtureDetailsSchema>;

export async function executeGetFixtureDetails(input: GetFixtureDetailsInput) {
  const { fixture_id, include } = input;
  const includeSet = new Set(include ?? ['stats', 'events', 'lineups']);

  // Fetch fixture details (always needed — contains score, status, teams)
  const fixtureRes = await apiFootballGet<any[]>('fixtures', { id: fixture_id });
  if (!fixtureRes.ok || !fixtureRes.data?.length) {
    return { found: false, fixture_id, errors: fixtureRes.errors || ['Fixture not found'] };
  }

  const f = fixtureRes.data[0];
  const result: Record<string, any> = {
    found: true,
    fixture_id,
    date: f.fixture?.date,
    referee: f.fixture?.referee,
    venue: f.fixture?.venue?.name,
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
    },
    home: { id: f.teams?.home?.id, name: f.teams?.home?.name },
    away: { id: f.teams?.away?.id, name: f.teams?.away?.name },
    score: {
      home: f.goals?.home,
      away: f.goals?.away,
      halftime: f.score?.halftime,
      fulltime: f.score?.fulltime,
    },
    events: f.events ?? [],
  };

  // Fetch additional data in parallel
  const promises: Promise<void>[] = [];

  if (includeSet.has('stats')) {
    promises.push(
      apiFootballGet<any[]>('fixtures/statistics', { fixture: fixture_id }).then(res => {
        if (res.ok && res.data?.length) {
          result.statistics = res.data.map((teamStat: any) => ({
            team: teamStat.team?.name,
            team_id: teamStat.team?.id,
            stats: Object.fromEntries(
              (teamStat.statistics || []).map((s: any) => [
                s.type?.toLowerCase().replace(/\s+/g, '_'),
                s.value,
              ])
            ),
          }));
        }
      })
    );
  }

  if (includeSet.has('lineups')) {
    promises.push(
      apiFootballGet<any[]>('fixtures/lineups', { fixture: fixture_id }).then(res => {
        if (res.ok && res.data?.length) {
          result.lineups = res.data.map((lineup: any) => ({
            team: lineup.team?.name,
            formation: lineup.formation,
            starting_xi: (lineup.startXI || []).map((p: any) => ({
              name: p.player?.name,
              number: p.player?.number,
              pos: p.player?.pos,
            })),
            substitutes: (lineup.substitutes || []).slice(0, 7).map((p: any) => ({
              name: p.player?.name,
              number: p.player?.number,
              pos: p.player?.pos,
            })),
            coach: lineup.coach?.name,
          }));
        }
      })
    );
  }

  await Promise.all(promises);
  return result;
}

export const getFixtureDetailsTool = {
  name: 'get_fixture_details',
  description:
    'Get full details for a football fixture: score, status, referee, venue, lineups, match statistics (shots, possession, passes, corners, fouls, cards), and events (goals, cards, substitutions). ' +
    'Works for upcoming, live, and completed matches. Requires fixture_id from search_football_fixtures. ' +
    'Use include param to limit API calls (e.g. ["stats"] for stats only).',
  inputSchema: getFixtureDetailsSchema,
  execute: executeGetFixtureDetails,
};
