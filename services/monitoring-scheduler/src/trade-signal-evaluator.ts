/**
 * TradeSignalEvaluator
 *
 * Reads MonitoringTask.signals[], resolves each signal's current value from
 * the strippedData produced by callToolsAndExtract(), evaluates each condition,
 * applies entryLogic / exitLogic (AND | OR | ANY), and returns a structured
 * signal state that processor.ts uses to decide whether to auto-close or alert.
 *
 * Value resolution order (handles both flat and tool-namespaced strippedData):
 *   1. Direct key: strippedData["indicators.rsi"]  (most common — extractFields stores by path string)
 *   2. Nested traversal: getValueAtPath(strippedData, "indicators.rsi")
 *   3. Tool namespace search: strippedData["tool0_get_market_snapshot"]["indicators.rsi"]
 */

import { MonitoringTask, SignalConfig } from './db/monitoring';
import { getValueAtPath } from './utils/field-extractor';
import { logger } from './utils/logger';

export interface SignalEvalState {
  signalId: string;
  label: string;
  role: 'entry' | 'exit';
  field: string;
  currentValue: number | null;   // null if value could not be resolved
  threshold: number;
  operator: string;
  triggered: boolean;
  resolved: boolean;             // false when value was not found in strippedData
}

export interface TradeSignalResult {
  hasSignals: boolean;
  entryTriggered: boolean;
  exitTriggered: boolean;
  entrySignals: SignalEvalState[];
  exitSignals: SignalEvalState[];
  allSignals: SignalEvalState[];
  /** Short human-readable summary for logging / alert messages */
  summary: string;
}

export class TradeSignalEvaluator {
  evaluate(task: MonitoringTask, strippedData: Record<string, any>): TradeSignalResult {
    if (!task.signals || task.signals.length === 0) {
      return {
        hasSignals: false,
        entryTriggered: false,
        exitTriggered: false,
        entrySignals: [],
        exitSignals: [],
        allSignals: [],
        summary: 'No signals configured',
      };
    }

    const allSignals: SignalEvalState[] = task.signals.map((sig) =>
      this.evaluateSignal(sig, strippedData)
    );

    const entrySignals = allSignals.filter((s) => s.role === 'entry');
    const exitSignals = allSignals.filter((s) => s.role === 'exit');

    const entryLogic = task.entryLogic || 'AND';
    const exitLogic = task.exitLogic || 'ANY';

    const entryTriggered =
      entrySignals.length > 0 && this.applyLogic(entrySignals, entryLogic);
    const exitTriggered =
      exitSignals.length > 0 && this.applyLogic(exitSignals, exitLogic);

    const triggeredExit = exitSignals.filter((s) => s.triggered);
    const triggeredEntry = entrySignals.filter((s) => s.triggered);

    let summary = 'Signals nominal';
    if (exitTriggered) {
      summary = `EXIT triggered (${exitLogic}): ${triggeredExit.map((s) => s.label).join(', ')}`;
    } else if (entryTriggered) {
      summary = `ENTRY triggered (${entryLogic}): ${triggeredEntry.map((s) => s.label).join(', ')}`;
    }

    logger.debug('SignalEvaluator', summary, {
      entryTriggered,
      exitTriggered,
      signals: allSignals.map((s) => ({
        id: s.signalId,
        value: s.currentValue,
        triggered: s.triggered,
        resolved: s.resolved,
      })),
    });

    return {
      hasSignals: true,
      entryTriggered,
      exitTriggered,
      entrySignals,
      exitSignals,
      allSignals,
      summary,
    };
  }

  private evaluateSignal(sig: SignalConfig, data: Record<string, any>): SignalEvalState {
    const value = this.resolveValue(sig.field, data);
    const resolved = value !== null;
    const triggered = resolved && this.evaluateCondition(value!, sig.operator, sig.threshold);

    return {
      signalId: sig.signalId,
      label: sig.label,
      role: sig.role,
      field: sig.field,
      currentValue: value,
      threshold: sig.threshold,
      operator: sig.operator,
      triggered,
      resolved,
    };
  }

  /**
   * Resolve a dot-path field from strippedData.
   * Handles three storage patterns produced by callToolsAndExtract:
   *   1. Flat key: { "indicators.rsi": 45.2 }
   *   2. Nested object: { indicators: { rsi: 45.2 } }
   *   3. Tool-namespaced: { "tool0_get_market_snapshot": { "indicators.rsi": 45.2 } }
   */
  private resolveValue(field: string, data: Record<string, any>): number | null {
    // 1. Direct key lookup (most common — extractFields stores result[fieldPath] = value)
    if (field in data) {
      const v = data[field];
      if (v !== null && v !== undefined && !Number.isNaN(Number(v))) return Number(v);
    }

    // 2. Nested object traversal
    const nested = getValueAtPath(data, field);
    if (nested !== undefined && nested !== null && !Number.isNaN(Number(nested))) {
      return Number(nested);
    }

    // 3. Search through tool-namespaced keys (tool0_toolname, tool1_toolname, ...)
    for (const key of Object.keys(data)) {
      const val = data[key];
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        // Direct key within namespace
        if (field in val) {
          const v = val[field];
          if (v !== null && v !== undefined && !Number.isNaN(Number(v))) return Number(v);
        }
        // Nested within namespace
        const nested2 = getValueAtPath(val, field);
        if (nested2 !== undefined && nested2 !== null && !Number.isNaN(Number(nested2))) {
          return Number(nested2);
        }
      }
    }

    return null;
  }

  private evaluateCondition(value: number, op: string, threshold: number): boolean {
    switch (op) {
      case '>':  return value > threshold;
      case '<':  return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
      case '!=': return value !== threshold;
      default:   return false;
    }
  }

  private applyLogic(signals: SignalEvalState[], logic: 'AND' | 'OR' | 'ANY'): boolean {
    if (logic === 'AND') return signals.every((s) => s.triggered);
    // OR and ANY are equivalent: at least one signal triggered
    return signals.some((s) => s.triggered);
  }
}

export const tradeSignalEvaluator = new TradeSignalEvaluator();
