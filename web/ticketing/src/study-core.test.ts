import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tasks, type Reply, type Status, type Task } from './model';
import { createRunStore, fingerprintFiles, runStudy, serialize, sha256, summarize, validateCorpus,
  validateDevelopment, type Client, type Corpus, type Development, type Fingerprints, type Report, type Row } from './study-core';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/ticketing-ja/cases.json', import.meta.url), 'utf8')) as Corpus;
const corpus = () => structuredClone(fixture);
const fingerprints: Fingerprints = { corpus_sha256: 'corpus', implementation_sha256: 'code', dependencies_sha256: 'lock' };
const status: Status = { model: Array(32).fill(7), warmed: true, max_tokens: 52, budget: 5_000_000_000n };
const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'ticketing-test-'));
  temporary.push(path); return path;
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function reply(task: Task, selected: string): Reply {
  const ids = tasks[task].options.map(o => o.id);
  return { ids, selected, probabilities: ids.map(id => id === selected ? 1 : 0), logits: ids.map(id => id === selected ? 5 : 0),
    confidence: 1, model: [...status.model], input_tokens: 40, measured_instructions: 3_000_000_000n };
}
function client(): Client {
  return { status: structuredClone(status), decide: vi.fn(async (task: Task, text: string) => {
    const ticket = [...fixture.development, ...fixture.evaluation].find(ticket => ticket.text === text)!;
    return reply(task, ticket[task]);
  }) };
}
function rows(): Row[] {
  return fixture.evaluation.flatMap(ticket => (['department', 'priority'] as const).map(task => ({
    id: ticket.id, task, expected: ticket[task], correct: true, seconds: 0.1, reply: reply(task, ticket[task]),
  })));
}
function makeWrong(rows: Row[], task: Task, count: number) {
  for (const row of rows.filter(row => row.task === task).slice(0, count)) {
    row.reply = reply(task, tasks[task].options.find(o => o.id !== row.expected)!.id);
    row.correct = false;
  }
}
async function development(root: string): Promise<Development> {
  const result = await runStudy({ split: 'development', corpus: corpus(), fingerprints, outputRoot: root, createClient: async () => client() });
  const bytes = readFileSync(result.reportPath);
  return { path: result.reportPath, sha256: sha256(bytes), report: JSON.parse(bytes.toString()) };
}
function evaluation(root: string, dev: Development, c = client()) {
  return runStudy({ split: 'evaluation', corpus: corpus(), fingerprints, outputRoot: root, development: dev, createClient: async () => c });
}

describe('corpus preflight', () => {
  it('accepts the moved fixture', () => expect(validateCorpus(corpus()).evaluation).toHaveLength(24));
  it.each([
    ['missing development case', (c: Corpus) => c.development.pop()],
    ['extra evaluation case', (c: Corpus) => c.evaluation.push({ ...c.evaluation[0], id: 'extra', text: 'extra' })],
    ['missing evaluation case', (c: Corpus) => c.evaluation.pop()],
    ['unknown department', (c: Corpus) => { c.evaluation[0].department = 'other'; }],
    ['unknown priority', (c: Corpus) => { c.evaluation[0].priority = 'critical'; }],
    ['empty text', (c: Corpus) => { c.evaluation[0].text = '  '; }],
    ['empty ID', (c: Corpus) => { c.evaluation[0].id = ''; }],
    ['duplicate ID across splits', (c: Corpus) => { c.evaluation[0].id = c.development[0].id; }],
    ['duplicate text across splits', (c: Corpus) => { c.evaluation[0].text = ` ${c.development[0].text} `; }],
    ['unbalanced categories', (c: Corpus) => { c.evaluation[0].department = 'hr'; }],
  ])('rejects %s before connecting', async (_, change) => {
    const data = corpus(); change(data);
    const createClient = vi.fn(async () => client());
    const root = directory();
    await expect(runStudy({ split: 'development', corpus: data, fingerprints, outputRoot: root, createClient })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('publication gate', () => {
  it.each(['department', 'priority'] as const)('accepts 20/24 but rejects 19/24 for %s', task => {
    const results = rows();
    makeWrong(results, task, 4);
    expect(summarize('evaluation', fixture.evaluation, results).passed).toBe(true);
    makeWrong(results, task, 5);
    expect(summarize('evaluation', fixture.evaluation, results).passed).toBe(false);
  });
  it('rejects one high priority miss even with 23/24 priority accuracy', () => {
    const results = rows();
    const high = results.find(r => r.task === 'priority' && r.expected === 'high')!;
    high.reply = reply('priority', 'normal'); high.correct = false;
    const summary = summarize('evaluation', fixture.evaluation, results);
    expect(summary.priority_correct).toBe(23);
    expect(summary.passed).toBe(false);
  });
  it('does not trust duplicate rows or fabricated correct flags', () => {
    const duplicate = rows(); duplicate[0] = duplicate[2];
    expect(summarize('evaluation', fixture.evaluation, duplicate).completed).toBe(false);
    const fabricated = rows(); makeWrong(fabricated, 'department', 1); fabricated[0].correct = true;
    expect(summarize('evaluation', fixture.evaluation, fabricated).completed).toBe(false);
  });
});

describe('development provenance', () => {
  it.each(['corpus_sha256', 'implementation_sha256', 'dependencies_sha256'] as const)('rejects changed %s before connecting', async key => {
    const root = directory(), dev = await development(root);
    const createClient = vi.fn(async () => client());
    await expect(runStudy({ split: 'evaluation', corpus: corpus(), fingerprints: { ...fingerprints, [key]: 'changed' },
      development: dev, outputRoot: root, createClient })).rejects.toThrow('changed');
    expect(createClient).not.toHaveBeenCalled();
  });
  it.each(['running', 'failed'])('rejects a %s development run', async state => {
    const dev = await development(directory());
    (dev.report as Report).state = state as Report['state'];
    expect(() => validateDevelopment(dev.report, fingerprints, corpus())).toThrow('successfully');
  });
  it('rejects legacy reports with an actionable message', () => {
    const legacy = { split: 'development', rows: [] };
    expect(() => validateDevelopment(legacy, fingerprints, corpus())).toThrow('run study:dev');
  });
  it('requires an explicit development report', async () => {
    const createClient = vi.fn(async () => client());
    await expect(runStudy({ split: 'evaluation', corpus: corpus(), fingerprints, outputRoot: directory(), createClient })).rejects.toThrow('--development');
    expect(createClient).not.toHaveBeenCalled();
  });
  it('detects incomplete or inconsistent development evidence', async () => {
    const dev = await development(directory());
    (dev.report as Report).rows.pop();
    expect(() => validateDevelopment(dev.report, fingerprints, corpus())).toThrow('summary');
  });
  it('rejects invalid query limits in a saved development report', async () => {
    const dev = await development(directory());
    (dev.report as Report).status!.max_tokens = Number.NaN;
    expect(() => validateDevelopment(dev.report, fingerprints, corpus())).toThrow('query limits');
  });
  it('fingerprints file contents and names in stable order', () => {
    const root = directory(); writeFileSync(join(root, 'a'), 'first'); writeFileSync(join(root, 'b'), 'second');
    const hash = fingerprintFiles(root, ['a', 'b']);
    expect(fingerprintFiles(root, ['b', 'a'])).toBe(hash);
    writeFileSync(join(root, 'b'), 'changed');
    expect(fingerprintFiles(root, ['a', 'b'])).not.toBe(hash);
  });
});

describe('CLI preflight without production queries', () => {
  const script = fileURLToPath(new URL('../scripts/study.ts', import.meta.url));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  it.each([
    ['evaluation'],
    ['evaluation', '--development', 'legacy'],
  ])('rejects unsupported invocation before connecting: %s', (...args) => {
    const actualArgs = args.map(arg => {
      if (arg !== 'legacy') return arg;
      const path = join(directory(), 'legacy.json');
      writeFileSync(path, JSON.stringify({ split: 'development', rows: [] }));
      return path;
    });
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, ...actualArgs], { cwd, encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toMatch(/requires --development|Legacy or invalid/);
  });
});

describe('offline runner and storage', () => {
  it('returns exit 0, links the explicit development record and preserves it', async () => {
    const root = directory(), dev = await development(root), before = readFileSync(dev.path);
    const c = client(), result = await evaluation(root, dev, c);
    expect(result.exitCode).toBe(0);
    expect(c.decide).toHaveBeenCalledTimes(48);
    expect(result.report.development).toEqual({ path: dev.path, sha256: sha256(before) });
    expect(readFileSync(dev.path)).toEqual(before);
    expect(result.report.state).toBe('completed');
    expect(result.reportPath).not.toBe(dev.path);
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).summary.passed).toBe(true);
  });
  it('returns exit 2 only for completed evaluations below the accuracy gate', async () => {
    const root = directory(), dev = await development(root), c = client();
    c.decide = async task => reply(task, task === 'department' ? 'it' : 'high');
    const result = await evaluation(root, dev, c);
    expect(result.exitCode).toBe(2);
    expect(result.report.state).toBe('completed');
    expect(result.report.summary?.completed).toBe(true);
  });
  it('stops before inference when the production model changed', async () => {
    const root = directory(), dev = await development(root), c = client();
    c.status.model = Array(32).fill(8);
    const result = await evaluation(root, dev, c);
    expect(c.decide).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(1);
    expect(result.report.rows).toEqual([]);
    expect(result.report.error).toContain('Model differs');
  });
  it.each(['transport', 'response', 'model change'])('returns exit 1 and preserves results on %s failures', async failure => {
    const root = directory(), dev = await development(root), before = readFileSync(dev.path), c = client();
    const original = c.decide;
    let calls = 0;
    c.decide = async (task, text) => {
      if (++calls !== 2) return original(task, text);
      if (failure === 'transport') throw new Error('offline network failure');
      return { ...await original(task, text), ...(failure === 'response' ? { confidence: NaN } : { model: Array(32).fill(9) }) };
    };
    const result = await evaluation(root, dev, c);
    expect(result.exitCode).toBe(1);
    expect(result.report.rows).toHaveLength(48);
    expect(result.report.rows.filter(row => row.error)).toHaveLength(1);
    expect(result.report.summary?.passed).toBe(false);
    expect(result.report.state).toBe('failed');
    expect(readFileSync(dev.path)).toEqual(before);
  });
  it('records setup failures without altering past runs', async () => {
    const root = directory(), dev = await development(root), before = readFileSync(dev.path);
    const result = await runStudy({ split: 'evaluation', corpus: corpus(), fingerprints, development: dev, outputRoot: root,
      createClient: async () => { throw new Error('cannot connect'); } });
    expect(result.exitCode).toBe(1);
    expect(result.report.error).toContain('cannot connect');
    expect(result.report.state).toBe('failed');
    expect(readFileSync(dev.path)).toEqual(before);
  });
  it('snapshots progress, refuses ID collisions and finalization overwrites', async () => {
    const root = directory(), dev = await development(root);
    const initial = { ...(dev.report as Report), state: 'running', rows: [], summary: undefined } as Report;
    const store = createRunStore(root, 'interrupted');
    store.save(initial);
    const progress = readFileSync(store.path);
    expect(JSON.parse(progress.toString()).state).toBe('running');
    expect(() => createRunStore(root, 'interrupted')).toThrow();
    expect(readFileSync(store.path)).toEqual(progress);
    const final = { ...initial, state: 'failed' as const, error: 'interrupted' };
    store.save(final);
    const finished = readFileSync(store.path);
    expect(() => store.save(initial)).toThrow('finalized');
    expect(readFileSync(store.path)).toEqual(finished);
    expect(readdirSync(join(root, 'interrupted'))).toEqual(['report.json']);
  });
  it('does not overwrite existing runs when started again with the same ID', async () => {
    const root = directory();
    const first = await runStudy({ split: 'development', corpus: corpus(), fingerprints, outputRoot: root, runId: 'fixed', createClient: async () => client() });
    const before = readFileSync(first.reportPath), createClient = vi.fn(async () => client());
    await expect(runStudy({ split: 'development', corpus: corpus(), fingerprints, outputRoot: root, runId: 'fixed', createClient })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
    expect(readFileSync(first.reportPath)).toEqual(before);
  });
  it('round-trips bigint and typed model bytes in reports', () => {
    expect(JSON.parse(serialize({ budget: 5n, model: new Uint8Array([7, 8]) }))).toEqual({ budget: '5', model: [7, 8] });
  });
});
