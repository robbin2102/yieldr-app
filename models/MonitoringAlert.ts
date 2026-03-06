import mongoose, { Document, Schema } from 'mongoose';

export interface IMonitoringAlert extends Document {
  userId: string;
  taskId: mongoose.Types.ObjectId;
  agentId: string;

  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  isSignal: boolean;
  data: Record<string, any>;
  indicators?: Array<{ name: string; value: string; dot: string; note: string }>;
  cycleNumber: number;
  read: boolean;

  createdAt: Date;
}

const MonitoringAlertSchema = new Schema<IMonitoringAlert>({
  userId: { type: String, required: true, lowercase: true },
  taskId: { type: Schema.Types.ObjectId, required: true, ref: 'MonitoringTask' },
  agentId: { type: String, required: true },

  title: { type: String, required: true },
  message: { type: String, required: true },
  severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
  isSignal: { type: Boolean, default: false },
  data: { type: Schema.Types.Mixed, default: {} },
  indicators: { type: Schema.Types.Mixed, default: [] },
  cycleNumber: { type: Number, required: true },
  read: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false }, collection: 'monitoring_alerts' });

MonitoringAlertSchema.index({ userId: 1, read: 1, createdAt: -1 });
MonitoringAlertSchema.index({ agentId: 1, createdAt: -1 });
MonitoringAlertSchema.index({ taskId: 1, createdAt: -1 });
// 30-day TTL
MonitoringAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });

export default mongoose.models.MonitoringAlert ||
  mongoose.model<IMonitoringAlert>('MonitoringAlert', MonitoringAlertSchema);
