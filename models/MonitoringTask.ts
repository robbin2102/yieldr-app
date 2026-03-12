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

export interface ISignalConfig {
  signalId: string;          // unique within the task, e.g. "rsi_exit"
  label: string;             // human-readable, e.g. "RSI > 70"
  sourceType: 'mongodb_snapshot' | 'taapi_live' | 'dedicated_collection' | 'computed';
  field: string;             // dot-path to value, e.g. "indicators.rsi"
  operator: '>' | '<' | '>=' | '<=' | '==' | '!=';
  threshold: number;
  role: 'entry' | 'exit';
}

export interface IMonitoringTask extends Document {
  userId: string;            // wallet address of creator
  agentId: string;           // links to Agent.agentId
  agentName: string;

  task: string;              // short title
  monitorInstruction: string; // detailed instruction for evaluator LLM

  // LLM-defined alpha thesis (populated after first cycle)
  alphaTitle?: string;
  alphaDescription?: string;

  // Trading linkage (set when task is created from a trade)
  mode: 'monitor' | 'autonomous' | 'confirm';
  linkedTradeSetupId?: string;   // TradeSetup._id
  linkedTradeIndex?: number;     // on-chain trade index (filled after execute-open)
  linkedPairIndex?: number;

  // Signal definitions (evaluated by TradeSignalEvaluator in Phase 5)
  signals: ISignalConfig[];
  entryLogic: 'AND' | 'OR' | 'ANY';   // how entry signals combine
  exitLogic: 'AND' | 'OR' | 'ANY';    // how exit signals combine

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

const SignalConfigSchema = new Schema<ISignalConfig>({
  signalId:   { type: String, required: true },
  label:      { type: String, required: true },
  sourceType: { type: String, enum: ['mongodb_snapshot', 'taapi_live', 'dedicated_collection', 'computed'], required: true },
  field:      { type: String, required: true },
  operator:   { type: String, enum: ['>', '<', '>=', '<=', '==', '!='], required: true },
  threshold:  { type: Number, required: true },
  role:       { type: String, enum: ['entry', 'exit'], required: true },
}, { _id: false });

const MonitoringTaskSchema = new Schema<IMonitoringTask>({
  userId: { type: String, required: true, lowercase: true },
  agentId: { type: String, required: true },
  agentName: { type: String, required: true },

  task: { type: String, required: true },
  monitorInstruction: { type: String, required: true },

  alphaTitle: { type: String },
  alphaDescription: { type: String },

  mode: { type: String, enum: ['monitor', 'autonomous', 'confirm'], default: 'monitor' },
  linkedTradeSetupId: { type: String },
  linkedTradeIndex:   { type: Number },
  linkedPairIndex:    { type: Number },

  signals:    { type: [SignalConfigSchema], default: [] },
  entryLogic: { type: String, enum: ['AND', 'OR', 'ANY'], default: 'AND' },
  exitLogic:  { type: String, enum: ['AND', 'OR', 'ANY'], default: 'ANY' },

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
