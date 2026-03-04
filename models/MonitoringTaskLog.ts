import mongoose, { Document, Schema } from 'mongoose';

export interface IMonitoringTaskLog extends Document {
  taskId: mongoose.Types.ObjectId;
  agentId: string;
  timestamp: Date;
  data: Record<string, any>;
  alerted: boolean;
  alertId?: mongoose.Types.ObjectId;
  summary: string;
  error?: string;
}

const MonitoringTaskLogSchema = new Schema<IMonitoringTaskLog>({
  taskId: { type: Schema.Types.ObjectId, required: true, ref: 'MonitoringTask' },
  agentId: { type: String, required: true },
  timestamp: { type: Date, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
  alerted: { type: Boolean, default: false },
  alertId: { type: Schema.Types.ObjectId, ref: 'MonitoringAlert' },
  summary: { type: String, default: '' },
  error: { type: String },
}, { _id: true });

MonitoringTaskLogSchema.index({ taskId: 1, timestamp: -1 });
MonitoringTaskLogSchema.index({ agentId: 1, timestamp: -1 });
// 7-day TTL
MonitoringTaskLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });

export default mongoose.models.MonitoringTaskLog ||
  mongoose.model<IMonitoringTaskLog>('MonitoringTaskLog', MonitoringTaskLogSchema);
