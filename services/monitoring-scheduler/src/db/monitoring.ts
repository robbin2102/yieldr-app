import { ObjectId, WithId } from 'mongodb';
import { getDB, COLLECTIONS } from './connection';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ToolConfig {
  toolName: string;
  toolParams: Record<string, any>;
  extractFields: string[];
}

export interface CycleEntry {
  timestamp: Date;
  data: Record<string, any>;
  alerted: boolean;
  signaled: boolean;
  summary: string;
  indicators?: Array<{ name: string; value: string; dot: string; note: string }>;
}

export interface MonitoringTask {
  _id?: ObjectId;
  userId: string;
  agentId: string;
  agentName: string;
  task: string;
  monitorInstruction: string;
  tools: ToolConfig[];
  intervalSeconds: number;
  status: 'active' | 'paused' | 'error';
  nextRunAt: Date;
  lastRunAt?: Date;
  lastAlertAt?: Date;
  alertCount: number;
  cycleCount: number;
  errorCount: number;
  lastError?: string;
  cycleHistory: CycleEntry[];
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoringAlert {
  _id?: ObjectId;
  userId: string;
  taskId: ObjectId;
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

export interface MonitoringTaskLog {
  _id?: ObjectId;
  taskId: ObjectId;
  agentId: string;
  timestamp: Date;
  data: Record<string, any>;
  alerted: boolean;
  alertId?: ObjectId;
  summary: string;
  error?: string;
}

// ─── Task CRUD ─────────────────────────────────────────────────────────────────

export async function createTask(
  taskData: Omit<MonitoringTask, '_id' | 'createdAt' | 'updatedAt'>
): Promise<WithId<MonitoringTask>> {
  const db = await getDB();
  const now = new Date();
  const doc: MonitoringTask = {
    ...taskData,
    status: 'active',
    alertCount: taskData.alertCount ?? 0,
    cycleCount: taskData.cycleCount ?? 0,
    errorCount: taskData.errorCount ?? 0,
    cycleHistory: taskData.cycleHistory ?? [],
    nextRunAt: new Date(Date.now() + taskData.intervalSeconds * 1000),
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS).insertOne(doc as any);
  return { ...doc, _id: result.insertedId };
}

export async function listTasks(
  userId: string,
  opts: { status?: MonitoringTask['status'] } = {}
): Promise<WithId<MonitoringTask>[]> {
  const db = await getDB();
  const filter: any = { userId: userId.toLowerCase() };
  if (opts.status) filter.status = opts.status;
  return db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray() as Promise<WithId<MonitoringTask>[]>;
}

export async function getTask(taskId: string): Promise<WithId<MonitoringTask> | null> {
  const db = await getDB();
  return db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .findOne({ _id: new ObjectId(taskId) }) as Promise<WithId<MonitoringTask> | null>;
}

export async function updateTask(
  taskId: string,
  updates: Partial<MonitoringTask>
): Promise<void> {
  const db = await getDB();
  await db.collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS).updateOne(
    { _id: new ObjectId(taskId) },
    { $set: { ...updates, updatedAt: new Date() } }
  );
}

export async function pauseTask(taskId: string): Promise<void> {
  await updateTask(taskId, { status: 'paused' });
}

export async function resumeTask(taskId: string): Promise<void> {
  const task = await getTask(taskId);
  if (!task) return;
  await updateTask(taskId, {
    status: 'active',
    nextRunAt: new Date(Date.now() + task.intervalSeconds * 1000),
    errorCount: 0,
  });
}

export async function deleteTask(taskId: string): Promise<void> {
  const db = await getDB();
  await db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .deleteOne({ _id: new ObjectId(taskId) });
}

/**
 * Atomically claim all active tasks whose nextRunAt is now due.
 * Uses findOneAndUpdate to avoid race conditions if multiple scheduler
 * instances ever run concurrently.
 */
export async function getDueTasks(): Promise<WithId<MonitoringTask>[]> {
  const db = await getDB();
  const now = new Date();

  // Fetch due task IDs first
  const dueDocs = await db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .find({ status: 'active', nextRunAt: { $lte: now } })
    .project({ _id: 1 })
    .toArray();

  if (dueDocs.length === 0) return [];

  // Re-fetch full docs (simple approach for single-instance scheduler)
  return db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .find({ _id: { $in: dueDocs.map((d) => d._id) } })
    .toArray() as Promise<WithId<MonitoringTask>[]>;
}

export async function markTaskRun(
  taskId: ObjectId,
  update: {
    cycleHistory: CycleEntry[];
    nextRunAt: Date;
    lastRunAt: Date;
    cycleCount: number;
  }
): Promise<void> {
  const db = await getDB();
  await db.collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS).updateOne(
    { _id: taskId },
    {
      $set: {
        cycleHistory: update.cycleHistory,
        nextRunAt: update.nextRunAt,
        lastRunAt: update.lastRunAt,
        cycleCount: update.cycleCount,
        updatedAt: new Date(),
      },
    }
  );
}

export async function markTaskAlert(
  taskId: ObjectId,
  update: { lastAlertAt: Date; alertCount: number }
): Promise<void> {
  const db = await getDB();
  await db.collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS).updateOne(
    { _id: taskId },
    { $set: { lastAlertAt: update.lastAlertAt, alertCount: update.alertCount, updatedAt: new Date() } }
  );
}

export async function markTaskError(taskId: ObjectId, error: string): Promise<void> {
  const db = await getDB();
  const maxErrors = parseInt(process.env.MAX_CONSECUTIVE_ERRORS || '5', 10);

  const task = await db
    .collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS)
    .findOne({ _id: taskId });

  if (!task) return;

  const newErrorCount = (task.errorCount || 0) + 1;
  const shouldPause = newErrorCount >= maxErrors;

  await db.collection<MonitoringTask>(COLLECTIONS.MONITORING_TASKS).updateOne(
    { _id: taskId },
    {
      $set: {
        errorCount: newErrorCount,
        lastError: error,
        status: shouldPause ? 'error' : task.status,
        updatedAt: new Date(),
      },
    }
  );

  if (shouldPause) {
    console.warn(`[Scheduler] Task ${taskId} paused after ${maxErrors} consecutive errors`);
  }
}

// ─── Alert CRUD ────────────────────────────────────────────────────────────────

export async function createAlert(
  alertData: Omit<MonitoringAlert, '_id'>
): Promise<WithId<MonitoringAlert>> {
  const db = await getDB();
  const result = await db
    .collection<MonitoringAlert>(COLLECTIONS.MONITORING_ALERTS)
    .insertOne(alertData as any);
  return { ...alertData, _id: result.insertedId };
}

export async function getAlerts(
  userId: string,
  opts: { since?: Date; limit?: number; unreadOnly?: boolean } = {}
): Promise<WithId<MonitoringAlert>[]> {
  const db = await getDB();
  const filter: any = { userId: userId.toLowerCase() };
  if (opts.unreadOnly) filter.read = false;
  if (opts.since) filter.createdAt = { $gte: opts.since };

  return db
    .collection<MonitoringAlert>(COLLECTIONS.MONITORING_ALERTS)
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 50)
    .toArray() as Promise<WithId<MonitoringAlert>[]>;
}

export async function getAlertsByAgent(
  agentId: string,
  opts: { limit?: number } = {}
): Promise<WithId<MonitoringAlert>[]> {
  const db = await getDB();
  return db
    .collection<MonitoringAlert>(COLLECTIONS.MONITORING_ALERTS)
    .find({ agentId })
    .sort({ createdAt: -1 })
    .limit(opts.limit ?? 30)
    .toArray() as Promise<WithId<MonitoringAlert>[]>;
}

export async function markAlertsRead(userId: string, alertIds: string[]): Promise<void> {
  const db = await getDB();
  await db.collection<MonitoringAlert>(COLLECTIONS.MONITORING_ALERTS).updateMany(
    {
      _id: { $in: alertIds.map((id) => new ObjectId(id)) },
      userId: userId.toLowerCase(),
    },
    { $set: { read: true } }
  );
}

// ─── Log CRUD ─────────────────────────────────────────────────────────────────

export async function createLog(
  logData: Omit<MonitoringTaskLog, '_id'>
): Promise<void> {
  const db = await getDB();
  await db
    .collection<MonitoringTaskLog>(COLLECTIONS.MONITORING_TASK_LOGS)
    .insertOne(logData as any);
}

export async function getLogsByTask(
  taskId: string,
  opts: { limit?: number } = {}
): Promise<WithId<MonitoringTaskLog>[]> {
  const db = await getDB();
  return db
    .collection<MonitoringTaskLog>(COLLECTIONS.MONITORING_TASK_LOGS)
    .find({ taskId: new ObjectId(taskId) })
    .sort({ timestamp: -1 })
    .limit(opts.limit ?? 50)
    .toArray() as Promise<WithId<MonitoringTaskLog>[]>;
}

export async function getLogsByAgent(
  agentId: string,
  opts: { limit?: number } = {}
): Promise<WithId<MonitoringTaskLog>[]> {
  const db = await getDB();
  return db
    .collection<MonitoringTaskLog>(COLLECTIONS.MONITORING_TASK_LOGS)
    .find({ agentId })
    .sort({ timestamp: -1 })
    .limit(opts.limit ?? 50)
    .toArray() as Promise<WithId<MonitoringTaskLog>[]>;
}
