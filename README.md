# retention-job

Delete by policy, and prove what will happen before anything is removed.

`planRetention` is a pure function over in-memory tables. It returns the exact rows that policy says
are deletable, the rows blocked because a live row still references them, and the monthly partitions
that are old enough to drop. `applyRetention` refuses to run unless the plan was built with
`dryRun: false`, so a preview can never be mistaken for an approval.

## Why

Retention bugs are one-way bugs. A cutoff compared with `<=` instead of `<`, or a parent row removed
while a child still points at it, is not visible until someone needs the data. A plan object makes
the decision reviewable: counts, ids, reasons, and a re-plan that should delete zero.

## Quickstart

```sh
node --test test/     # 16 tests, < 500 ms, no dependencies
node src/cli.mjs      # fixed-clock dry run, apply, then re-plan
node verify.mjs       # writes evidence.json
```

```js
import { planRetention, applyRetention } from './src/index.mjs';

const preview = planRetention({ tables, now });
if (preview.delete.length > 0) {
  // review preview.delete / preview.blocked / preview.partitionsDropped
}

const plan = planRetention({ tables, now, dryRun: false });
const report = applyRetention({ tables, plan });
// { deleted: 12, byTable: { runs: 4, ... }, partitionsDropped: [...] }
```

## Policy

`POLICY` is frozen:

| Data | Window |
|---|---|
| `runs` | 90 days |
| `tutor_messages`, age band `minor` | 30 days |
| `tutor_messages`, all other bands | 90 days |
| `ai_usage_hourly` | 365 days |
| `progress_events` partitions | 24 whole months |
| `sessions` | 30 days |

A row is deletable when `createdAt < now - ttlDays * 86400000`. **Exactly at the cutoff is kept.**
A partition is dropped when its month is more than 24 months before the UTC month of `now`; a
partition exactly 24 months old is kept.

## Contract

`planRetention({ tables, now, dryRun = true, references = [] })` returns:

| Field | Meaning |
|---|---|
| `dryRun` | the flag the plan was built with |
| `delete` | `[{ table, id }]`, unique, policy table order then row order |
| `blocked` | `[{ table, id, reason }]` for rows kept by a live reference |
| `kept` | rows not deleted (blocked rows count as kept) |
| `partitionsDropped` | `[{ table: 'progress_events', month: '2022-05' }]` |
| `counts` | per table `{ total, delete, blocked, kept }` |

`references` is `[{ table, id, referencedBy: { table, id } }]`. If the referring row exists and is
not itself being deleted, the target is blocked. A dangling reference does not protect a row.
Blocking is iterated to a fixpoint, so a chain of references cannot delete a row that something live
still points at.

`applyRetention({ tables, plan })` mutates the arrays in place, removes the ids, drops the planned
partitions, and returns `{ deleted, byTable, partitionsDropped }`. It throws `DRY_RUN` unless
`plan.dryRun === false`, and verifies the plan first.

`verifyPlan(plan)` throws `DUPLICATE_DELETE` or `DELETE_AND_BLOCKED`; otherwise returns `true`.

## What this proves, and what it does not

Proven by `test/retention-job.test.mjs`: every window at its exact boundary and one step past it,
dry run immutability, apply only after approval, referential blocking, partition month math,
duplicate-id suppression, counts matching arrays, and a second plan returning zero deletes.

Not proven: database transactions, foreign keys in a real store, backup expungement, or that the
caller's `tables` mirror the database. A real job must stream ids from the store, delete in
batches, and record an audit row per batch; this module is the decision layer for that job.

## Permissions

None at runtime. No network, no secrets, no environment reads, no filesystem writes, no child
processes. `applyRetention` only mutates the arrays it is given. CI requests `contents: read` only.
See `permission-manifest.json`.

## License

MIT (c) 2026 Revan
