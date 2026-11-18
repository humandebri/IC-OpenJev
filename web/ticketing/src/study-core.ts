import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CANISTER, HOST, tasks, validateReply, type Reply, type Status, type Task } from './model';

export type Split = 'development' | 'evaluation';
export type Ticket = { id: string; text: string; department: string; priority: string };
export type Corpus = Record<Split, Ticket[]>;
export type Fingerprints = { corpus_sha256: string; implementation_sha256: string; dependencies_sha256: string };
export type Row = { id: string; task: Task; expected: string; correct: boolean; seconds: number; reply?: Reply; error?: string };
export type Summary = { cases: number; completed: boolean; department_correct: number; priority_correct: number; high_priority_correct: number; high_priority_total: number; passed: boolean };
export type Report = {
  format_version: 2; run_id: string; split: Split; state: 'running' | 'completed' | 'failed';
  started_at: string; finished_at?: string; host: string; canister: string;
  fingerprints: Fingerprints; development?: { path: string; sha256: string };
  tasks: typeof tasks; status?: Status; rows: Row[]; summary?: Summary; error?: string;
};
export type Client = { status: Status; decide(task: Task, text: string): Promise<Reply> };
export type Development = { path: string; sha256: string; report: unknown };
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function fingerprintFiles(root: string, paths: string[]): string {
  return sha256(JSON.stringify([...paths].sort().map(path => [path, sha256(readFileSync(join(root, path)))])));
}
export function validateCorpus(value: unknown): Corpus {
  if (!record(value)) throw new Error('Invalid corpus');
  const ids = new Set<string>(), texts = new Set<string>();
  for (const split of ['development', 'evaluation'] as const) {
    const rows = value[split];
    if (!Array.isArray(rows) || rows.length !== (split === 'development' ? 12 : 24)) throw new Error(`Invalid ${split} case count`);
    const combinations = new Map<string, number>();
    for (const row of rows) {
      if (!record(row) || typeof row.id !== 'string' || !row.id.trim()
        || typeof row.text !== 'string' || !row.text.trim()
        || !tasks.department.options.some(o => o.id === row.department)
        || !tasks.priority.options.some(o => o.id === row.priority)) throw new Error(`Invalid ${split} case`);
      const id = row.id.trim(), text = row.text.trim();
      if (ids.has(id) || texts.has(text)) throw new Error('Duplicate case ID or text');
      ids.add(id); texts.add(text);
      const key = `${row.department}/${row.priority}`;
      combinations.set(key, (combinations.get(key) ?? 0) + 1);
    }
    if (split === 'evaluation') {
      for (const department of tasks.department.options) {
        for (const priority of tasks.priority.options) {
          if (combinations.get(`${department.id}/${priority.id}`) !== 2) throw new Error('Unbalanced evaluation corpus');
        }
      }
    }
  }
  return value as Corpus;
}

// Completeness is checked by case ID and task, not by a supplied correct flag.
export function summarize(split: Split, tickets: Ticket[], rows: Row[]): Summary {
  const seen = new Set<string>();
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));
  let completed = rows.length === tickets.length * 2;
  const correct = { department: 0, priority: 0 };
  let highCorrect = 0;
  for (const row of rows) {
    const ticket = byId.get(row.id), key = `${row.id}/${row.task}`;
    if (!ticket || (row.task !== 'department' && row.task !== 'priority') || seen.has(key)) {
      completed = false; continue;
    }
    seen.add(key);
    if (row.expected !== ticket[row.task] || row.error !== undefined || !row.reply) {
      completed = false; continue;
    }
    const matches = row.reply.selected === ticket[row.task];
    if (row.correct !== matches) completed = false;
    if (matches) correct[row.task]++;
    if (row.task === 'priority' && ticket.priority === 'high' && matches) highCorrect++;
  }
  const highTotal = tickets.filter(ticket => ticket.priority === 'high').length;
  return { cases: tickets.length, completed, department_correct: correct.department, priority_correct: correct.priority,
    high_priority_correct: highCorrect, high_priority_total: highTotal,
    passed: split === 'evaluation' && tickets.length === 24 && completed
      && correct.department >= 20 && correct.priority >= 20 && highTotal === 8 && highCorrect === 8 };
}

function modelDigest(value: unknown): string {
  const bytes = value instanceof Uint8Array ? Array.from(value) : value;
  if (!Array.isArray(bytes) || bytes.length !== 32 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('Invalid model identifier');
  return Buffer.from(bytes).toString('hex');
}

export function validateDevelopment(value: unknown, fingerprints: Fingerprints, corpus: Corpus): string {
  if (!record(value) || value.format_version !== 2) {
    throw new Error('Legacy or invalid development report; run study:dev to create a format_version=2 report');
  }
  if (value.split !== 'development' || value.state !== 'completed' || !record(value.summary)
    || value.summary.completed !== true || !Array.isArray(value.rows) || !record(value.status)
    || value.status.warmed !== true || value.host !== HOST || value.canister !== CANISTER) throw new Error('Development report did not complete successfully');
  const storedFingerprints = value.fingerprints;
  if (!record(storedFingerprints) || Object.entries(fingerprints).some(([key, hash]) => storedFingerprints[key] !== hash)) {
    throw new Error('Development corpus, implementation or dependencies changed; run study:dev again');
  }
  if (JSON.stringify(value.tasks) !== JSON.stringify(tasks)) throw new Error('Development task configuration changed');
  const status = { ...value.status, budget: BigInt(String(value.status.budget)) } as Status;
  modelDigest(status.model);
  if (!Number.isInteger(status.max_tokens) || status.max_tokens < 1 || status.budget < 1n) throw new Error('Invalid development query limits');
  const rows: Row[] = value.rows.map(row => {
    if (!record(row) || !record(row.reply) || (row.task !== 'department' && row.task !== 'priority')
      || typeof row.id !== 'string' || typeof row.expected !== 'string' || typeof row.correct !== 'boolean'
      || typeof row.seconds !== 'number' || !Number.isFinite(row.seconds) || row.seconds < 0 || row.error !== undefined) throw new Error('Invalid development result row');
    const reply = { ...row.reply, measured_instructions: BigInt(String(row.reply.measured_instructions)) } as Reply;
    validateReply(reply, row.task, status);
    return { ...row, reply } as Row;
  });
  const summary = summarize('development', corpus.development, rows);
  const storedSummary = value.summary;
  if (!summary.completed || Object.entries(summary).some(([key, val]) => storedSummary[key] !== val)) throw new Error('Invalid development summary');
  return modelDigest(status.model);
}

export function serialize(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString()
    : item instanceof Uint8Array ? Array.from(item) : item, 2) + '\n';
}

export function createRunStore(root: string, runId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('Invalid run ID');
  mkdirSync(root, { recursive: true });
  const directory = join(root, runId);
  mkdirSync(directory); // A collision must never overwrite an earlier run.
  const path = join(directory, 'report.json');
  let final = false;
  return { path, save(report: Report) {
    if (final) throw new Error('Run already finalized');
    const temporary = join(directory, 'report.tmp');
    writeFileSync(temporary, serialize(report), { flag: 'wx' });
    renameSync(temporary, path);
    final = report.state !== 'running';
  } };
}

export async function runStudy(options: {
  split: Split; corpus: unknown; fingerprints: Fingerprints; outputRoot: string; development?: Development;
  createClient: () => Promise<Client>; runId?: string;
}) {
  const corpus = validateCorpus(options.corpus);
  let expectedModel: string | undefined;
  if (options.split === 'evaluation') {
    if (!options.development) throw new Error('Evaluation requires --development <report.json>');
    expectedModel = validateDevelopment(options.development.report, options.fingerprints, corpus);
  } else if (options.development) throw new Error('--development is only valid for evaluation');
  const started = new Date().toISOString();
  const runId = options.runId ?? `${started.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const store = createRunStore(options.outputRoot, runId);
  const report: Report = { format_version: 2, run_id: runId, split: options.split, state: 'running', started_at: started,
    host: HOST, canister: CANISTER, fingerprints: options.fingerprints, tasks, rows: [],
    ...(options.development ? { development: { path: resolve(options.development.path), sha256: options.development.sha256 } } : {}) };
  store.save(report);
  try {
    const client = await options.createClient();
    const status = structuredClone(client.status);
    report.status = status;
    const actualModel = modelDigest(status.model);
    if (!status.warmed || !Number.isInteger(status.max_tokens) || status.max_tokens < 1
      || typeof status.budget !== 'bigint' || status.budget < 1n) throw new Error('Model unavailable or invalid query limits');
    if (expectedModel && expectedModel !== actualModel) throw new Error('Model differs from development; no evaluation inference was started');
    store.save(report);
    for (const ticket of corpus[options.split]) {
      for (const task of ['department', 'priority'] as const) {
        const began = performance.now();
        try {
          const reply = validateReply(await client.decide(task, ticket.text), task, status);
          report.rows.push({ id: ticket.id, task, expected: ticket[task], correct: reply.selected === ticket[task],
            seconds: (performance.now() - began) / 1000, reply });
        } catch (error) {
          report.rows.push({ id: ticket.id, task, expected: ticket[task], correct: false,
            seconds: (performance.now() - began) / 1000, error: String(error) });
        }
        store.save(report);
      }
    }
    report.summary = summarize(options.split, corpus[options.split], report.rows);
    report.state = report.summary.completed ? 'completed' : 'failed';
  } catch (error) {
    report.state = 'failed'; report.error = String(error);
  }
  report.finished_at = new Date().toISOString();
  store.save(report);
  const exitCode = report.state === 'failed' ? 1 : options.split === 'evaluation' && !report.summary?.passed ? 2 : 0;
  return { report, reportPath: store.path, exitCode };
}
