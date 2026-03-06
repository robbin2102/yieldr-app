import mongoose, { Document, Schema } from 'mongoose';

export interface IToolConfig {
  toolName: string;
  toolParams: Record<string, any>;
  extractFields: string[];
}

export interface ICycleEntry {
  timestamp: Date;
  data: Record<string, any>;
  alerted: boolean;
  summary: string;
}

export interface IMonitoringTask extends Document {
  userId: string;            // wallet address of creator
  agentId: string;           // links to Agent.agentId
  agentName: string;

  task: string;              // short title
  monitorInstruction: string; // detailed instruction for evaluator LLM

  tools: IToolConfig[];
  intervalSeconds: number;
  status: 'active' | 'paused' | 'error';

  nextRunAt: Date;
  lastRunAt?: Date;
  lastAlertAt?: Date;
  alertCount: number;
  cycleCount: number;
  errorCount: number;
  lastError?: string;

  cycleHistory: ICycleEntry[];  // rolling last 5 cycles

  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ToolConfigSchema = new Schema<IToolConfig>({
  toolName: { type: String, required: true },
  toolParams: { type: Schema.Types.Mixed, default: {} },
  extractFields: [{ type: String }],
}, { _id: false });

const CycleEntrySchema = new Schema<ICycleEntry>({
  timestamp: { type: Date, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
  alerted: { type: Boolean, default: false },
  summary: { type: String, default: '' },
}, { _id: false });

const MonitoringTaskSchema = new Schema<IMonitoringTask>({
  userId: { type: String, required: true, lowercase: true },
  agentId: { type: String, required: true },
  agentName: { type: String, required: true },

  task: { type: String, required: true },
  monitorInstruction: { type: String, required: true },

  tools: { type: [ToolConfigSchema], required: true },
  intervalSeconds: { type: Number, required: true, min: 300 },
  status: { type: String, enum: ['active', 'paused', 'error'], default: 'active' },

  nextRunAt: { type: Date, required: true },
  lastRunAt: { type: Date },
  lastAlertAt: { type: Date },
  alertCount: { type: Number, default: 0 },
  cycleCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
  lastError: { type: String },

  cycleHistory: { type: [CycleEntrySchema], default: [] },

  expiresAt: { type: Date },
}, { timestamps: true, collection: 'monitoring_tasks' });

MonitoringTaskSchema.index({ userId: 1, status: 1 });
MonitoringTaskSchema.index({ status: 1, nextRunAt: 1 });
MonitoringTaskSchema.index({ agentId: 1 });

export default mongoose.models.MonitoringTask ||
  mongoose.model<IMonitoringTask>('MonitoringTask', MonitoringTaskSchema);
