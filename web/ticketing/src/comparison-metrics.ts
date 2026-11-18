import { tasks, type Task } from './model';

export type ComparisonCase = { id: string; text: string; department: string; priority: string };
export type ComparisonRow = { id: string; task: Task; expected: string; selected?: string; error?: string };

/** All-case accuracy counts failed requests separately and never drops them from the denominator. */
export function comparisonMetrics(cases: ComparisonCase[], rows: ComparisonRow[]) {
  if (new Set(cases.map(row => row.id)).size !== cases.length || rows.length !== cases.length * 2) throw new Error('Incomplete comparison cases');
  const indexed = new Map<string, ComparisonRow>();
  for (const row of rows) {
    const expected = cases.find(ticket => ticket.id === row.id);
    const key = `${row.id}/${row.task}`;
    if (!expected || !(row.task in tasks) || row.expected !== expected[row.task] || indexed.has(key)) throw new Error('Mismatched comparison row');
    if ((row.selected === undefined) === (row.error === undefined)) throw new Error('Expected a selection or an error');
    if (row.selected !== undefined && !tasks[row.task].options.some(option => option.id === row.selected)) throw new Error('Unknown selected option');
    indexed.set(key, row);
  }
  const taskMetrics = (task: Task) => {
    const results = rows.filter(row => row.task === task);
    const returned = results.filter(row => row.selected !== undefined).length;
    const correct = results.filter(row => row.selected === row.expected).length;
    return { correct, total: cases.length, returned, errors: cases.length - returned,
      accuracy_all: correct / cases.length, accuracy_returned: returned ? correct / returned : null };
  };
  const high = cases.filter(row => row.priority === 'high').map(row => indexed.get(`${row.id}/priority`)!);
  const joint = cases.filter(ticket => (['department', 'priority'] as const).every(task => indexed.get(`${ticket.id}/${task}`)?.selected === ticket[task])).length;
  return { cases: cases.length, department: taskMetrics('department'), priority: taskMetrics('priority'),
    joint_correct: joint, joint_accuracy: joint / cases.length,
    high_priority: { total: high.length, detected: high.filter(row => row.selected === 'high').length,
      missed: high.filter(row => row.selected !== undefined && row.selected !== 'high').length,
      unanswered: high.filter(row => row.selected === undefined).length } };
}
