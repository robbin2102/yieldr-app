import mongoose, { Schema, Document, Model, Connection } from 'mongoose';

export interface IExchangeResponse {
  content: string;
  input_tokens: number;
  output_tokens: number;
  response_time_ms: number;
  model: string;
}

export interface IExchange {
  exchange_number: number;
  timestamp: Date;
  user_message: string;
  responses: {
    claude?: IExchangeResponse;
    openai?: IExchangeResponse;
    grok?: IExchangeResponse;
  };
}

export interface ISessionState {
  exchange_count: number;
  topics_covered: string[];
  offer_presented: boolean;
  nudge_used: boolean;
  community_mentioned: boolean;
  objections_raised: string[];
  vault_interest?: string;
  outcome?: string;
}

export interface IChatSession extends Document {
  session_id: string;
  created_at: Date;
  updated_at: Date;
  test_label: string;
  status: 'active' | 'completed' | 'abandoned';
  exchanges: IExchange[];
  state: ISessionState;
  summary_history: string[];
  notes: string;
}

const ExchangeResponseSchema = new Schema<IExchangeResponse>(
  {
    content: String,
    input_tokens: Number,
    output_tokens: Number,
    response_time_ms: Number,
    model: String,
  },
  { _id: false }
);

const ExchangeSchema = new Schema<IExchange>(
  {
    exchange_number: Number,
    timestamp: { type: Date, default: Date.now },
    user_message: String,
    responses: {
      claude: ExchangeResponseSchema,
      openai: ExchangeResponseSchema,
      grok: ExchangeResponseSchema,
    },
  },
  { _id: false }
);

const ChatSessionSchema = new Schema<IChatSession>({
  session_id: { type: String, required: true, unique: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  test_label: { type: String, default: '' },
  status: { type: String, enum: ['active', 'completed', 'abandoned'], default: 'active' },
  exchanges: [ExchangeSchema],
  state: {
    exchange_count: { type: Number, default: 0 },
    topics_covered: [String],
    offer_presented: { type: Boolean, default: false },
    nudge_used: { type: Boolean, default: false },
    community_mentioned: { type: Boolean, default: false },
    objections_raised: [String],
    vault_interest: String,
    outcome: String,
  },
  summary_history: [String],
  notes: { type: String, default: '' },
});

// Returns a model bound to the provided connection (yieldr_agent_test DB)
export function getChatSessionModel(conn: Connection): Model<IChatSession> {
  return conn.models.ChatSession ||
    conn.model<IChatSession>('ChatSession', ChatSessionSchema, 'chat_sessions');
}

// Fallback singleton for environments where connection is pre-established
const ChatSession: Model<IChatSession> =
  mongoose.models.ChatSession ||
  mongoose.model<IChatSession>('ChatSession', ChatSessionSchema, 'chat_sessions');

export default ChatSession;
