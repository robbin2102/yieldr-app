/**
 * Get Football Injuries
 * Returns injury/suspension list for a fixture or team.
 */

import { z } from 'zod';
import { apiFootballGet } from '../../utils/api-football.js';

export const getFootballInjuriesSchema = z.object({
  fixture_id: z.number().optional().describe('Fixture ID to get injuries for both teams in a specific match'),
  team_id: z.number().optional().describe('Team ID to get all current injuries for a specific team'),
  season: z.number().optional().describe('Season year (required if using team_id). Defaults to current year.'),
});

export type GetFootballInjuriesInput = z.infer<typeof getFootballInjuriesSchema>;

export async function executeGetFootballInjuries(input: GetFootballInjuriesInput) {
  const { fixture_id, team_id, season = new Date().getFullYear() } = input;

  if (!fixture_id && !team_id) {
    return { found: false, error: 'Provide either fixture_id or team_id' };
  }

  const params: Record<string, string | number | undefined> = {};
  if (fixture_id) params.fixture = fixture_id;
  if (team_id) {
    params.team = team_id;
    params.season = season;
  }

  const res = await apiFootballGet<any[]>('injuries', params);
  if (!res.ok) {
    return { found: false, errors: res.errors };
  }

  if (!res.data?.length) {
    return { found: true, total: 0, message: 'No injuries reported', injuries: [] };
  }

  // Group injuries by team
  const byTeam = new Map<number, { name: string; injuries: any[] }>();

  for (const inj of res.data) {
    const tid = inj.team?.id;
    if (!tid) continue;

    if (!byTeam.has(tid)) {
      byTeam.set(tid, { name: inj.team.name, injuries: [] });
    }

    byTeam.get(tid)!.injuries.push({
      player: inj.player?.name,
      type: inj.player?.type, // e.g. "Missing Fixture", "Questionable"
      reason: inj.player?.reason, // e.g. "Knee Injury", "Suspended"
    });
  }

  const teams = Array.from(byTeam.entries()).map(([id, data]) => ({
    team_id: id,
    team: data.name,
    total: data.injuries.length,
    players: data.injuries,
  }));

  return {
    found: true,
    ...(fixture_id ? { fixture_id } : { team_id }),
    total: res.data.length,
    teams,
  };
}

export const getFootballInjuriesTool = {
  name: 'get_football_injuries',
  description:
    'Get injury and suspension list for a football fixture or team. ' +
    'Returns injured/suspended players grouped by team with injury type and reason. ' +
    'Use fixture_id for both teams in a match, or team_id for a specific team.',
  inputSchema: getFootballInjuriesSchema,
  execute: executeGetFootballInjuries,
};
