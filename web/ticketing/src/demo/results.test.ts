import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import corpus from '../../../../fixtures/ticketing-ja/cases.json';
import { createHash } from 'node:crypto';
import { tasks } from '../model';

// Synthetic selections test validation without publishing experiment measurements.
const source = readFileSync(new URL('../../../../fixtures/ticketing-ja/cases.json', import.meta.url), 'utf8');
const evaluation = {
  corpus_sha256: createHash('sha256').update(source).digest('hex'),
  rows: corpus.evaluation.flatMap(c => (['department', 'priority'] as const).map(task => {
    const ids = tasks[task].options.map(option => option.id as string);
    return { id: c.id, task, expected: c[task], reply: { selected: c[task], ids, probabilities: ids.map(id => id === c[task] ? 1 : 0) } };
  })),
  summary: { department_correct: 24, priority_correct: 24 },
};
import { confusion, joinResults, loadRecordedResults, score } from './results';

describe('demo results', () => {
  const results = joinResults(corpus.evaluation, evaluation.rows);

  it('reproduces the recorded summary from raw selections', () => {
    expect(results).toHaveLength(24);
    expect(score(results, 'department')).toBe(evaluation.summary.department_correct);
    expect(score(results, 'priority')).toBe(evaluation.summary.priority_correct);
  });

  it('builds confusion matrices that cover every case', () => {
    for (const task of ['department', 'priority'] as const) {
      const { counts } = confusion(results, task);
      expect(counts.flat().reduce((a, b) => a + b, 0)).toBe(24);
    }
  });

  it('rejects a row whose expectation disagrees with the fixture', () => {
    const rows = evaluation.rows.map(r => r.id === 'evaluation-01' && r.task === 'department' ? { ...r, expected: 'hr' } : r);
    expect(() => joinResults(corpus.evaluation, rows)).toThrow(/evaluation-01/);
  });

  it('verifies the exact fixture bytes before showing recorded results', async () => {
    const source = readFileSync(new URL('../../../../fixtures/ticketing-ja/cases.json', import.meta.url), 'utf8');
    const verified = await loadRecordedResults(source, evaluation);
    expect(score(verified, 'department')).toBe(24);
    expect(score(verified, 'priority')).toBe(24);
    await expect(loadRecordedResults(source + '\n', evaluation)).rejects.toThrow('一致しない');
  });

  it('rejects changed text even when the case ID and expected labels are unchanged', async () => {
    const changed = structuredClone(corpus);
    changed.evaluation[0].text = '別の問い合わせ';
    await expect(loadRecordedResults(JSON.stringify(changed), evaluation)).rejects.toThrow('一致しない');
  });

  it('rejects duplicate rows and unknown selected IDs', () => {
    const duplicate = structuredClone(evaluation.rows);
    duplicate[1] = duplicate[0];
    expect(() => joinResults(corpus.evaluation, duplicate)).toThrow('duplicate');
    const invalid = structuredClone(evaluation.rows);
    invalid[0].reply.selected = 'unknown';
    expect(() => joinResults(corpus.evaluation, invalid)).toThrow('Invalid result');
  });
});
