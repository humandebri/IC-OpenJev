import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { CANISTER, HOST, connect, requestFor, type Task } from '../src/model';
import { sha256, serialize } from '../src/study-core';
import { comparisonMetrics, type ComparisonCase, type ComparisonRow } from '../src/comparison-metrics';

async function main() {
  const { values } = parseArgs({ options: { reference: { type: 'string' } } });
  if (!values.reference) throw new Error('Usage: compare-current.ts --reference <completed 70M/130M comparison report>');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const corpusBytes = readFileSync(join(root, 'fixtures/ticketing-ja/comparison/cases.json'));
  const corpus = JSON.parse(corpusBytes.toString()) as { test: ComparisonCase[] };
  const referencePath = resolve(values.reference), referenceBytes = readFileSync(referencePath);
  const reference = JSON.parse(referenceBytes.toString());
  if (reference.state !== 'completed' || reference.corpus_sha256 !== sha256(corpusBytes) || corpus.test.length !== 48) throw new Error('Reference must use the same frozen corpus');
  const candidate = reference.models.find((model: { name: string }) => model.name === 'sbintuitions/modernbert-ja-130m');
  if (!candidate || candidate.trials.length !== 3 || new Set(candidate.trials.map((trial: { seed: number }) => trial.seed)).size !== 3) throw new Error('Expected all three preselected 130M trials');
  const candidateMetrics = candidate.trials.map((trial: { seed: number; predictions: { id: string; department: { expected: string; selected: string }; priority: { expected: string; selected: string } }[] }) => ({
    seed: trial.seed, metrics: comparisonMetrics(corpus.test, trial.predictions.flatMap(row => (['department', 'priority'] as const).map(task => ({ id: row.id, task, expected: row[task].expected, selected: row[task].selected })))),
  }));
  const started = new Date().toISOString(), runId = `${started.replace(/[:.]/g, '-')}-${randomUUID()}`;
  const directory = join(root, 'artifacts/ticketing-ja/current-vs-130m', runId);
  mkdirSync(directory, { recursive: true });
  const binary = join(root, 'target/release/ticketing_probe');
  const nativeRows: ComparisonRow[] = [], apiRows: ComparisonRow[] = [];
  const details: unknown[] = [];
  const report = { format_version: 1, state: 'running', started_at: started, finished_at: '', host: HOST, canister: CANISTER,
    corpus_sha256: sha256(corpusBytes), reference: { path: referencePath, sha256: sha256(referenceBytes) },
    script_sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), model_client_sha256: sha256(readFileSync(join(root, 'web/ticketing/src/model.ts'))),
    metrics_sha256: sha256(readFileSync(join(root, 'web/ticketing/src/comparison-metrics.ts'))),
    native_source_sha256: sha256(readFileSync(join(root, 'crates/verdict-candle/src/bin/ticketing_probe.rs'))), native_binary_sha256: sha256(readFileSync(binary)),
    native_pack_sha256: sha256(readFileSync(join(root, 'models/verdict-pack/manifest.json'))),
    protocol: { same_test_cases: 48, current_model: 'deployed INT8 openJev; frozen candidate prompts; no additional training',
      candidate_model: '130M, locally fine-tuned; reuse all three previously selected trials; no retraining or test-based selection',
      native_limit: 128, api_queries: 96, truncate: false,
      latency_comparison: 'not comparable: current API includes network; native probe is CPU; candidate measurements were MPS GPU' },
    candidate: candidateMetrics, status: {} as unknown, details,
    summary: {} as unknown, error: '' };
  const save = () => { const temporary = join(directory, 'report.tmp'); writeFileSync(temporary, serialize(report)); renameSync(temporary, join(directory, 'report.json')); };
  save();
  const native = spawn(binary, [root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((yes, no) => { native.once('exit', code => yes(code)); native.once('error', no); });
  void exited.catch(() => {});
  let stderr = '';
  native.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const reader = createInterface({ input: native.stdout })[Symbol.asyncIterator]();
  try {
    await once(native, 'spawn');
    const client = await connect();
    report.status = client.status;
    const digest = Buffer.from(client.status.model).toString('hex');
    if (report.native_pack_sha256 !== digest) throw new Error('Local pack differs from deployed model');
    let matched = 0, comparable = 0;
    for (const ticket of corpus.test) {
      for (const task of ['department', 'priority'] as const) {
        const request = requestFor(task, ticket.text);
        native.stdin.write(JSON.stringify(request) + '\n');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const line = await Promise.race([reader.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Native inference timed out')), 60_000); })]).finally(() => clearTimeout(timer));
        if (line.done) throw new Error(`Native process stopped: ${stderr}`);
        const full = JSON.parse(line.value) as { ids: string[]; selected: string; model: number[]; input_tokens: number; logits: number[]; probabilities: number[] };
        if (Buffer.from(full.model).toString('hex') !== digest || !request.options.some(option => option.id === full.selected)
          || full.ids.length !== request.options.length || full.ids.some((id, i) => id !== request.options[i].id)
          || full.input_tokens < 1 || full.input_tokens > 128 || full.probabilities.some(value => !Number.isFinite(value))) throw new Error('Invalid native response');
        nativeRows.push({ id: ticket.id, task, expected: ticket[task], selected: full.selected });
        const began = performance.now();
        let api: unknown;
        try {
          const response = await client.decide(task, ticket.text);
          api = { reply: response, seconds: (performance.now() - began) / 1000 };
          apiRows.push({ id: ticket.id, task, expected: ticket[task], selected: response.selected });
          comparable++; if (response.selected === full.selected) matched++;
        } catch (error) {
          api = { error: String(error), seconds: (performance.now() - began) / 1000 };
          apiRows.push({ id: ticket.id, task, expected: ticket[task], error: String(error) });
        }
        details.push({ id: ticket.id, task, expected: ticket[task], request, native: full, api });
        save();
        console.log(`${ticket.id} ${task} native=${full.selected} expected=${ticket[task]} tokens=${full.input_tokens} api=${apiRows.at(-1)!.selected ?? 'error'}`);
      }
    }
    const after = await connect();
    if (Buffer.from(after.status.model).toString('hex') !== digest || after.status.max_tokens !== client.status.max_tokens) throw new Error('Model or query limits changed during comparison');
    report.summary = { native: comparisonMetrics(corpus.test, nativeRows), deployed_api: comparisonMetrics(corpus.test, apiRows),
      api_native_agreement: { matched, comparable },
      token_lengths: { min: Math.min(...(details as { native: { input_tokens: number } }[]).map(row => row.native.input_tokens)), max: Math.max(...(details as { native: { input_tokens: number } }[]).map(row => row.native.input_tokens)) } };
    if (!comparable || matched !== comparable) throw new Error('Native and API selections were not fully concordant; inspect before drawing conclusions');
    report.state = 'completed';
  } catch (error) {
    report.state = 'failed'; report.error = String(error); process.exitCode = 1;
  } finally {
    native.stdin.end();
    native.kill();
    await exited.catch(() => {});
    report.finished_at = new Date().toISOString(); save();
  }
  console.log('Report:', join(directory, 'report.json'));
  console.log(serialize(report.summary));
  if (report.error) console.error(report.error);
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
