import { NextRequest, NextResponse } from 'next/server';
import connectAgentDB from '@/lib/agent-test/db';
import { getChatSessionModel } from '@/lib/agent-test/models/ChatSession';

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const conn = await connectAgentDB();
  const ChatSession = getChatSessionModel(conn);

  const session = await ChatSession.findOne({ session_id: params.id }).lean();
  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(session);
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await req.json();
  const conn = await connectAgentDB();
  const ChatSession = getChatSessionModel(conn);

  const allowed = ['test_label', 'status', 'notes', 'state'];
  const update: Record<string, unknown> = { updated_at: new Date() };

  for (const key of allowed) {
    if (key in body) {
      if (key === 'state') {
        for (const [stateKey, stateVal] of Object.entries(body.state)) {
          update[`state.${stateKey}`] = stateVal;
        }
      } else {
        update[key] = body[key];
      }
    }
  }

  const session = await ChatSession.findOneAndUpdate(
    { session_id: params.id },
    { $set: update },
    { new: true }
  ).lean();

  if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(session);
}
