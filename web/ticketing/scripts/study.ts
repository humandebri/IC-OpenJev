import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { connect } from '../src/model';
import { fingerprintFiles, runStudy, serialize, sha256, type Development } from '../src/study-core';

async function main() {
  const { values, positionals } = parseArgs({ options: { development: { type: 'string' } }, allowPositionals: true });
  const split = positionals[0];
  if (positionals.length !== 1 || (split !== 'development' && split !== 'evaluation')) {
    throw new Error('Usage: study.ts development | evaluation --development <report.json>');
  }
  if ((split === 'evaluation') !== Boolean(values.development)) {
    throw new Error('Only evaluation requires --development <report.json>');
  }
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const corpus = readFileSync(new URL('../../../fixtures/ticketing-ja/cases.json', import.meta.url));
  let development: Development | undefined;
  if (values.development) {
    const path = resolve(values.development);
    const bytes = readFileSync(path);
    development = { path, sha256: sha256(bytes), report: JSON.parse(bytes.toString()) };
  }
  const result = await runStudy({ split, corpus: JSON.parse(corpus.toString()), development,
    fingerprints: {
      corpus_sha256: sha256(corpus),
      implementation_sha256: fingerprintFiles(root, ['web/ticketing/scripts/study.ts', 'web/ticketing/src/model.ts', 'web/ticketing/src/study-core.ts']),
      dependencies_sha256: fingerprintFiles(root, ['web/ticketing/package.json', 'web/ticketing/pnpm-lock.yaml', 'web/ticketing/pnpm-workspace.yaml']),
    }, outputRoot: fileURLToPath(new URL('../../../artifacts/ticketing-ja/runs/', import.meta.url)), createClient: connect });
  console.log(`Report: ${result.reportPath}`);
  console.log(serialize(result.report.summary ?? { error: result.report.error }).trim());
  process.exitCode = result.exitCode;
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
