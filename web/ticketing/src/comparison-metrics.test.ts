import { describe, expect, it } from 'vitest';
import corpus from '../../../fixtures/ticketing-ja/comparison/cases.json';
import { comparisonMetrics, type ComparisonRow } from './comparison-metrics';

const cases = corpus.test;
const perfect = (): ComparisonRow[] => cases.flatMap(row => (['department', 'priority'] as const).map(task => ({ id: row.id, task, expected: row[task], selected: row[task] })));
describe('current model comparison metrics', () => {
  it('recomputes perfect accuracy from the selections', () => {
    const result = comparisonMetrics(cases, perfect());
    expect(result.department.accuracy_all).toBe(1);
    expect(result.priority.accuracy_all).toBe(1);
    expect(result.joint_correct).toBe(48);
    expect(result.high_priority).toEqual({ total: 16, detected: 16, missed: 0, unanswered: 0 });
  });
  it('does not silently exclude API input-limit errors', () => {
    const rows = perfect();
    const index = rows.findIndex(row => row.task === 'priority' && row.expected === 'high');
    rows[index] = { id: rows[index].id, task: 'priority', expected: 'high', error: 'Capacity' };
    const result = comparisonMetrics(cases, rows);
    expect(result.priority.returned).toBe(47);
    expect(result.priority.accuracy_all).toBe(47 / 48);
    expect(result.priority.accuracy_returned).toBe(1);
    expect(result.joint_correct).toBe(47);
    expect(result.high_priority).toEqual({ total: 16, detected: 15, missed: 0, unanswered: 1 });
  });
  it('separates wrong high priority predictions from unanswered requests', () => {
    const rows = perfect();
    rows.find(row => row.task === 'priority' && row.expected === 'high')!.selected = 'normal';
    expect(comparisonMetrics(cases, rows).high_priority).toEqual({ total: 16, detected: 15, missed: 1, unanswered: 0 });
  });
  it('returns null conditional accuracy when the API answers nothing', () => {
    const rows = perfect().map(({ selected: _, ...row }) => ({ ...row, error: 'Capacity' }));
    const result = comparisonMetrics(cases, rows);
    expect(result.department.accuracy_all).toBe(0);
    expect(result.department.accuracy_returned).toBeNull();
    expect(result.high_priority.unanswered).toBe(16);
  });
  it('rejects duplicates, incomplete rows, unexpected labels and unknown selections', () => {
    const duplicate = perfect(); duplicate[0] = duplicate[1];
    expect(() => comparisonMetrics(cases, duplicate)).toThrow('Mismatched');
    expect(() => comparisonMetrics(cases, perfect().slice(1))).toThrow('Incomplete');
    const mismatch = perfect(); mismatch[0].expected = 'unknown';
    expect(() => comparisonMetrics(cases, mismatch)).toThrow('Mismatched');
    const selected = perfect(); selected[0].selected = 'unknown';
    expect(() => comparisonMetrics(cases, selected)).toThrow('Unknown');
  });
});
