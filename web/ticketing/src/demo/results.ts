import { tasks, type Task } from '../model';

export const labels: Record<Task, Record<string, string>> = {
  department: { it: 'IT', hr: '人事', finance: '経理', admin: '総務' },
  priority: { low: '低', normal: '通常', high: '高' },
};

export type Case = { id: string; text: string; department: string; priority: string };
export type Row = { id: string; task: string; expected: string; reply?: { selected: string; ids: string[]; probabilities: number[] } };
export type Judgement = { expected: string; selected: string; confidence: number; correct: boolean };
export type CaseResult = { id: string; text: string } & Record<Task, Judgement>;

/** Hash the original UTF-8 source, rather than re-serializing JSON and losing byte identity. */
export async function loadRecordedResults(source: string, evaluation: { corpus_sha256: string; rows: Row[] }): Promise<CaseResult[]> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== evaluation.corpus_sha256) throw new Error('評価記録と入力データが一致しないため、固定評価の表示を停止しました。');
  const corpus = JSON.parse(source) as { evaluation: Case[] };
  return joinResults(corpus.evaluation, evaluation.rows);
}

/** Join fixture cases with recorded evaluation rows, re-checking correctness from the raw selection. */
export function joinResults(cases: Case[], rows: Row[]): CaseResult[] {
  if (rows.length !== cases.length * 2 || new Set(cases.map(c => c.id)).size !== cases.length
    || new Set(rows.map(row => `${row.id}/${row.task}`)).size !== rows.length) throw new Error('Invalid or duplicate evaluation rows');
  return cases.map(c => {
    const pick = (task: Task): Judgement => {
      const row = rows.find(r => r.id === c.id && r.task === task);
      if (!row?.reply || row.expected !== c[task]) throw new Error(`Missing or mismatched result for ${c.id}/${task}`);
      const i = row.reply.ids.indexOf(row.reply.selected);
      const expectedIds = tasks[task].options.map(option => option.id as string);
      if (!expectedIds.includes(c[task]) || i < 0 || !expectedIds.includes(row.reply.selected)
        || row.reply.ids.length !== expectedIds.length || row.reply.ids.some((id, index) => id !== expectedIds[index])
        || row.reply.probabilities.length !== expectedIds.length
        || row.reply.probabilities.some(p => !Number.isFinite(p) || p < 0 || p > 1)) throw new Error(`Invalid result for ${c.id}/${task}`);
      return { expected: c[task], selected: row.reply.selected, confidence: row.reply.probabilities[i], correct: row.reply.selected === c[task] };
    };
    return { id: c.id, text: c.text, department: pick('department'), priority: pick('priority') };
  });
}

/** counts[expected][selected] in the task's option order. */
export function confusion(results: CaseResult[], task: Task) {
  const ids = tasks[task].options.map(o => o.id as string);
  const counts = ids.map(() => ids.map(() => 0));
  for (const r of results) counts[ids.indexOf(r[task].expected)][ids.indexOf(r[task].selected)]++;
  return { ids, counts };
}

export function score(results: CaseResult[], task: Task) {
  return results.filter(r => r[task].correct).length;
}
