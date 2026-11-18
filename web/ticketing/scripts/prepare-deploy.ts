// cf 1.0.0-beta.2 Build Output Specification v0, assets-only deployment.
// Preparing this directory is local; cf deploy --prebuilt publishes it explicitly.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const { worker, ...settings } = JSON.parse(await readFile(join(root, 'deploy.config.json'), 'utf8'));
const out = join(root, '.cloudflare/output/v0');
await readFile(join(root, 'dist/index.html')); // Refuse to package an absent build.
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'workers/default'), { recursive: true });
await writeFile(join(out, 'config.json'), JSON.stringify({ ...settings, buildContext: { mode: 'production', isPreview: false } }, null, 2));
await writeFile(join(out, 'workers/default/worker.config.json'), JSON.stringify(worker, null, 2));
await cp(join(root, 'dist'), join(out, 'workers/default/assets'), { recursive: true });
console.log(`Prepared assets-only Worker ${worker.name}: ${worker.domains.join(', ')}`);
