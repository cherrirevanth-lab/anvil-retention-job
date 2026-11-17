// SPDX-License-Identifier: MIT
import { applyRetention, planRetention } from './index.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2024, 5, 15, 12, 0, 0);
const ago = (days) => NOW - days * DAY;

const data = {
  runs: [
    { id: 'run-old', createdAt: ago(120), userId: 'u1' },
    { id: 'run-keep', createdAt: ago(10), userId: 'u1' },
  ],
  tutor_messages: [
    { id: 'msg-minor-old', createdAt: ago(31), userId: 'u2', ageBand: 'minor' },
    { id: 'msg-minor-keep', createdAt: ago(30), userId: 'u2', ageBand: 'minor' },
  ],
  ai_usage_hourly: [{ id: 'usage-1', createdAt: ago(366), userId: 'u1' }],
  sessions: [{ id: 'sess-1', createdAt: ago(10), userId: 'u1' }],
  progress_events: { partitions: [{ month: '2022-05' }, { month: '2022-06' }] },
};

const references = [
  { table: 'runs', id: 'run-old', referencedBy: { table: 'sessions', id: 'sess-1' } },
];

const preview = planRetention({ tables: data, now: NOW, references });

// The preview proves the deletion is blocked by a live session.
const approved = planRetention({ tables: data, now: NOW, dryRun: false, references });
const report = applyRetention({ tables: data, plan: approved });

const after = planRetention({ tables: data, now: NOW, dryRun: false, references });

console.log(JSON.stringify({
  policy: { runs: 90, tutorMinor: 30, tutorAdult: 90, aiUsage: 365, partitionsMonths: 24 },
  preview: {
    dryRun: preview.dryRun,
    delete: preview.delete,
    blocked: preview.blocked,
    partitionsDropped: preview.partitionsDropped,
    kept: preview.kept,
  },
  report,
  secondPlanDeletes: after.delete.length,
  remainingRuns: data.runs.map((row) => row.id),
  ok: preview.dryRun === true
    && preview.delete.length === 2
    && preview.blocked.length === 1
    && preview.partitionsDropped.length === 1
    && report.deleted === 2
    && after.delete.length === 0,
}, null, 2));

process.exitCode = 0;
