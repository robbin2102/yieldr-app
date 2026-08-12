import mongoose, { Schema, Document } from 'mongoose';

/**
 * MVP placeholder chat log. The agent aside doesn't reason yet - every
 * user message is saved (so nothing is lost once real reasoning ships
 * post-MVP) and answered with a fixed "coming soon" reply.
 */
export interface IEdgeChatMessage extends Document {
  wallet: string;
  role: 'user' | 'agent';
  message: string;
  createdAt: Date;
}

const EdgeChatMessageSchema = new Schema<IEdgeChatMessage>(
  {
    wallet: { type: String, required: true, lowercase: true, index: true },
    role: { type: String, enum: ['user', 'agent'], required: true },
    message: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'edge_chat_messages' }
);

EdgeChatMessageSchema.index({ wallet: 1, createdAt: 1 });

export const EdgeChatMessage =
  mongoose.models.EdgeChatMessage || mongoose.model<IEdgeChatMessage>('EdgeChatMessage', EdgeChatMessageSchema);
