// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRetention, planRetention, verifyPlan, POLICY } from '../src/index.mjs';

const DAY = 86_400_000;
const NOW = Date.UTC(2024, 5, 15, 12, 0, 0);
const ago = (days) => NOW - days * DAY;
const row = (id, createdAt, extra = {}) => ({ id, createdAt, userId: 'u1', ...extra });

function tables(overrides = {}) {
  return {
    runs: [],
    tutor_messages: [],
    ai_usage_hourly: [],
    sessions: [],
    ...overrides,
  };
}

test('a row exactly at the cutoff is kept', () => {
  const plan = planRetention({ tables: tables({ runs: [row('r90', ago(90))] }), now: NOW });
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.kept, 1);
});

test('a row one millisecond past the cutoff is deleted', () => {
  const plan = planRetention({ tables: tables({ runs: [row('r90p1', ago(90) - 1)] }), now: NOW });
  assert.deepEqual(plan.delete, [{ table: 'runs', id: 'r90p1' }]);
});

test('a minor tutor message is kept at 30 days and deleted at 31', () => {
  const plan = planRetention({
    tables: tables({
      tutor_messages: [
        row('m30', ago(30), { ageBand: 'minor' }),
        row('m31', ago(31), { ageBand: 'minor' }),
      ],
    }),
    now: NOW,
  });
  assert.deepEqual(plan.delete, [{ table: 'tutor_messages', id: 'm31' }]);
  assert.equal(plan.counts.tutor_messages.kept, 1);
});

test('an adult tutor message is kept at 90 days and deleted at 91', () => {
  const plan = planRetention({
    tables: tables({
      tutor_messages: [
        row('a90', ago(90), { ageBand: 'adult' }),
        row('a91', ago(91), { ageBand: 'adult' }),
        row('unknown90', ago(90)),
      ],
    }),
    now: NOW,
  });
  assert.deepEqual(plan.delete, [{ table: 'tutor_messages', id: 'a91' }]);
  assert.equal(plan.counts.tutor_messages.kept, 2);
});

test('run history is kept at 90 days and deleted at 91', () => {
  const plan = planRetention({
    tables: tables({ runs: [row('r90', ago(90)), row('r91', ago(91))] }),
    now: NOW,
  });
  assert.deepEqual(plan.delete, [{ table: 'runs', id: 'r91' }]);
});

test('hourly AI usage is kept at 365 days and deleted at 366', () => {
  const plan = planRetention({
    tables: tables({ ai_usage_hourly: [row('h365', ago(365)), row('h366', ago(366))] }),
    now: NOW,
  });
  assert.deepEqual(plan.delete, [{ table: 'ai_usage_hourly', id: 'h366' }]);
});

test('a dry run reports deletions without mutating any table', () => {
  const data = tables({ runs: [row('r1', ago(200)), row('r2', ago(1))] });
  const before = JSON.stringify(data);
  const plan = planRetention({ tables: data, now: NOW });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.delete.length, 1);
  assert.equal(JSON.stringify(data), before);
});

test('an approved plan deletes the rows it listed', () => {
  const data = tables({ runs: [row('r1', ago(200)), row('r2', ago(1))] });
  const plan = planRetention({ tables: data, now: NOW, dryRun: false });
  const report = applyRetention({ tables: data, plan });
  assert.equal(report.deleted, 1);
  assert.deepEqual(data.runs.map((r) => r.id), ['r2']);
});

test('applying a dry-run plan is refused with DRY_RUN', () => {
  const data = tables({ runs: [row('r1', ago(200))] });
  const plan = planRetention({ tables: data, now: NOW });
  assert.throws(
    () => applyRetention({ tables: data, plan }),
    (error) => error.code === 'DRY_RUN',
  );
  assert.equal(data.runs.length, 1);
});

test('a row referenced by a live row is blocked, not deleted', () => {
  const data = tables({ runs: [row('old', ago(200)), row('fresh', ago(1))] });
  const plan = planRetention({
    tables: data,
    now: NOW,
    dryRun: false,
    references: [{ table: 'runs', id: 'old', referencedBy: { table: 'runs', id: 'fresh' } }],
  });
  assert.deepEqual(plan.delete, []);
  assert.equal(plan.blocked.length, 1);
  assert.equal(plan.blocked[0].id, 'old');
  assert.match(plan.blocked[0].reason, /fresh/);
  assert.equal(plan.counts.runs.blocked, 1);
});

test('a partition exactly 24 months old is kept, one month older is dropped', () => {
  const data = tables({
    progress_events: { partitions: [{ month: '2022-05' }, { month: '2022-06' }, { month: '2024-06' }] },
  });
  const plan = planRetention({ tables: data, now: NOW });
  assert.deepEqual(plan.partitionsDropped, [{ table: 'progress_events', month: '2022-05' }]);
});

test('duplicate row ids never produce duplicate delete entries', () => {
  const data = tables({ runs: [row('dup', ago(200)), row('dup', ago(200))] });
  const plan = planRetention({ tables: data, now: NOW });
  const keys = plan.delete.map((entry) => `${entry.table}/${entry.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(plan.delete.length, 1);
});

test('counts agree with the lengths of the returned arrays', () => {
  const data = tables({
    runs: [row('r1', ago(200)), row('r2', ago(1))],
    tutor_messages: [row('m1', ago(40), { ageBand: 'minor' }), row('m2', ago(10), { ageBand: 'minor' })],
    sessions: [row('s1', ago(31)), row('s2', ago(30))],
  });
  const plan = planRetention({ tables: data, now: NOW });
  const tableTotal = Object.keys(plan.counts).length;
  assert.equal(tableTotal, 4);
  const deleted = Object.values(plan.counts).reduce((sum, c) => sum + c.delete, 0);
  const kept = Object.values(plan.counts).reduce((sum, c) => sum + c.kept, 0);
  assert.equal(deleted, plan.delete.length);
  assert.equal(kept, plan.kept);
  assert.equal(deleted + kept, Object.values(plan.counts).reduce((sum, c) => sum + c.total, 0));
});

test('a second plan after apply deletes nothing', () => {
  const data = tables({ runs: [row('r1', ago(200)), row('r2', ago(1))] });
  const first = planRetention({ tables: data, now: NOW, dryRun: false });
  applyRetention({ tables: data, plan: first });
  const second = planRetention({ tables: data, now: NOW, dryRun: false });
  assert.equal(second.delete.length, 0);
  assert.equal(second.kept, 1);
});

test('verifyPlan refuses a duplicate delete and a delete/blocked overlap', () => {
  assert.throws(
    () => verifyPlan({
      dryRun: false,
      delete: [{ table: 'runs', id: 'x' }, { table: 'runs', id: 'x' }],
      blocked: [],
    }),
    (error) => error.code === 'DUPLICATE_DELETE',
  );
  assert.throws(
    () => verifyPlan({
      dryRun: false,
      delete: [{ table: 'runs', id: 'x' }],
      blocked: [{ table: 'runs', id: 'x', reason: 'referenced' }],
    }),
    (error) => error.code === 'DELETE_AND_BLOCKED',
  );
});

test('the policy constant is frozen and holds the documented windows', () => {
  assert.equal(Object.isFrozen(POLICY), true);
  assert.deepEqual(
    { runs: POLICY.runs, minor: POLICY.tutor_messages, adult: POLICY.tutor_messages_adult },
    { runs: 90, minor: 30, adult: 90 },
  );
  assert.equal(POLICY.progress_events_months, 24);
});
