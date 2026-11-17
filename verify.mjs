// SPDX-License-Identifier: MIT
// Project self-verification. Exits 0 only when every check passes and writes
// evidence.json next to this file. No network, no dependencies.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const started = Date.now();
const checks = [];
const run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 });

const unit = run(['--test', 'test/']);
const passLine = (unit.stdout.match(/^ℹ pass (\d+)$/m) || [])[1] ?? '0';
const failLine = (unit.stdout.match(/^ℹ fail (\d+)$/m) || [])[1] ?? '?';
checks.push({
  name: 'unit-tests',
  ok: unit.status === 0,
  detail: `${passLine} passed, ${failLine} failed`,
});

const smoke = run(['src/cli.mjs']);
checks.push({
  name: 'cli-smoke',
  ok: smoke.status === 0 && smoke.stdout.includes('"ok": true'),
  detail: smoke.status === 0 ? 'dry run, apply and re-plan demo reports ok' : (smoke.stderr || 'cli failed').slice(0, 200),
});

const ok = checks.every((c) => c.ok);
const evidence = {
  project: '15-retention-job',
  node: process.version,
  ok,
  durationMs: Date.now() - started,
  checks,
};
writeFileSync(new URL('./evidence.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
process.exitCode = ok ? 0 : 1;
