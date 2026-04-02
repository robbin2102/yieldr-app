import { NextRequest, NextResponse } from 'next/server';
import connectAgentDB from '@/lib/agent-test/db';
import { getChatSessionModel } from '@/lib/agent-test/models/ChatSession';

export async function GET() {
  const conn = await connectAgentDB();
  const ChatSession = getChatSessionModel(conn);

  const sessions = await ChatSession.find(
    {},
    {
      session_id: 1,
      test_label: 1,
      created_at: 1,
      status: 1,
      'state.exchange_count': 1,
      'state.outcome': 1,
      'state.vault_interest': 1,
    }
  )
    .sort({ created_at: -1 })
    .limit(200)
    .lean();

  return NextResponse.json(sessions);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const conn = await connectAgentDB();
  const ChatSession = getChatSessionModel(conn);

  const session = await ChatSession.create({
    ...body,
    status: 'active',
    exchanges: [],
    state: {
      exchange_count: 0,
      topics_covered: [],
      offer_presented: false,
      nudge_used: false,
      community_mentioned: false,
      objections_raised: [],
    },
    summary_history: [],
  });

  return NextResponse.json(session, { status: 201 });
}
