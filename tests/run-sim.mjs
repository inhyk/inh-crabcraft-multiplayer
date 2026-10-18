// pnpm test:sim: the shipped combat code headless in Node (tests/sim/harness.ts, built on the
// spike's area in server/sim/spike), checked through its event sink.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const esbuild = require(require.resolve('esbuild', { paths: [require.resolve('wrangler')] }));
esbuild.buildSync({ entryPoints: ['tests/sim/harness.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'tmp/test-modules/sim-harness.js', logLevel: 'warning' });
const files = readdirSync('tests').filter((f) => /^sim-.*\.test\.mjs$/.test(f)).map((f) => `tests/${f}`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
