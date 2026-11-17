# Rebuild contract — retention-job

Anything that satisfies this document and passes `test/retention-job.test.mjs` is a valid
reconstruction. The tests are the oracle; this is the map.

## 1. File tree

```
15-retention-job/
├─ package.json            type: module, scripts: test/start/verify, no dependencies
├─ src/index.mjs           exports POLICY, planRetention, applyRetention, verifyPlan
├─ src/cli.mjs             fixed-clock preview -> apply -> re-plan demo, exits 0
├─ test/retention-job.test.mjs   16 acceptance tests
├─ verify.mjs              runs tests + CLI smoke, writes evidence.json
├─ permission-manifest.json
├─ .github/workflows/ci.yml
├─ README.md
├─ SPEC.md
├─ SECURITY.md
├─ LICENSE
└─ .gitignore
```

## 2. Public API

```ts
const POLICY = Object.freeze({
  runs: 90,
  tutor_messages: 30,
  tutor_messages_adult: 90,
  ai_usage_hourly: 365,
  progress_events_months: 24,
  sessions: 30,
});

function planRetention(input: {
  tables: Record<string, any>;
  now: number;
  dryRun?: boolean;            // default true
  references?: Array<{ table: string; id: string; referencedBy: { table: string; id: string } }>;
}): {
  dryRun: boolean;
  delete: Array<{ table: string; id: string }>;
  blocked: Array<{ table: string; id: string; reason: string }>;
  kept: number;
  partitionsDropped: Array<{ table: 'progress_events'; month: string }>;
  counts: Record<string, { total: number; delete: number; blocked: number; kept: number }>;
};

function applyRetention(input: { tables: object; plan: Plan }): {
  deleted: number;
  byTable: Record<string, number>;
  partitionsDropped: Array<{ table: 'progress_events'; month: string }>;
};

function verifyPlan(plan: Plan): true;
```

## 3. Algorithm

1. Validate `tables` (object), `now` (finite), `references` (array).
2. For each row table in `['runs','tutor_messages','ai_usage_hourly','sessions']`:
   - `rows = tables[table] ?? []`; every row needs a non-empty string `id`;
   - `ttl = POLICY[table]`, except `tutor_messages`: `ageBand === 'minor' ? 30 : 90`;
   - `cutoff = now - ttl * 86_400_000`;
   - candidate if `Number.isFinite(createdAt) && createdAt < cutoff`.
3. Referential pass:
   - build `table -> Map(id -> row)`;
   - for each reference whose target is a candidate: if the referrer row exists and is not a
     candidate, remove the target from candidates and record it as blocked;
   - repeat until no candidate is removed (cascade safety).
4. Emit `delete` de-duplicated by `table + id`, in row order. Emit `blocked` in reference order.
   `counts[table] = { total, delete, blocked, kept: total - delete }`. `kept` is the sum of kept.
5. Partitions: only when `tables.progress_events` is `{ partitions: [...] }`. Month index is
   `year * 12 + (month - 1)`; drop when `index < currentIndex - 24`, where current index comes from
   the UTC year and month of `now`.
6. `applyRetention`:
   - reject `plan.dryRun !== false` with code `DRY_RUN`;
   - call `verifyPlan`;
   - group ids per table, rewrite each array in place with the surviving rows;
   - filter `progress_events.partitions` by the planned months (also in place);
   - return actual removed counts, not planned counts.
7. `verifyPlan`: duplicate `table + id` in `delete` is `DUPLICATE_DELETE`; any key present in both
   `delete` and `blocked` is `DELETE_AND_BLOCKED`. Return `true`.

## 4. Invariants → owning test

| # | Invariant | Test |
|---|---|---|
| R1 | `createdAt == cutoff` kept | `a row exactly at the cutoff is kept` |
| R2 | `cutoff - 1 ms` deleted | `a row one millisecond past the cutoff is deleted` |
| R3 | Minor tutor 30/31 | `a minor tutor message is kept at 30 days and deleted at 31` |
| R4 | Adult tutor 90/91 | `an adult tutor message is kept at 90 days and deleted at 91` |
| R5 | Runs 90/91 | `run history is kept at 90 days and deleted at 91` |
| R6 | AI usage 365/366 | `hourly AI usage is kept at 365 days and deleted at 366` |
| R7 | Dry run mutates nothing | `a dry run reports deletions without mutating any table` |
| R8 | Approved plan deletes exactly its list | `an approved plan deletes the rows it listed` |
| R9 | Dry-run plan refused | `applying a dry-run plan is refused with DRY_RUN` |
| R10 | Live reference blocks | `a row referenced by a live row is blocked, not deleted` |
| R11 | Partition 24-month boundary | `a partition exactly 24 months old is kept...` |
| R12 | No duplicate ids | `duplicate row ids never produce duplicate delete entries` |
| R13 | Counts match arrays | `counts agree with the lengths of the returned arrays` |
| R14 | Apply is idempotent through replanning | `a second plan after apply deletes nothing` |
| R15 | Bad plan refused | `verifyPlan refuses a duplicate delete and a delete/blocked overlap` |
| R16 | Policy frozen | `the policy constant is frozen...` |

## 5. Boundaries

The comparison is strict (`<`). `createdAt === now - ttl * 86400000` is kept; one millisecond older
is deleted. Partitions use whole UTC months, not days: the current month minus 24 is kept, minus 25
is dropped.

`references` protects data, not correctness of the caller's reference list. A missing reference can
still delete a parent. `applyRetention` mutates only the supplied arrays; persistence, batching and
audit logs are the caller's job.

## 6. Rebuild checklist

- [ ] `node --test test/` → all passing.
- [ ] `node src/cli.mjs` exits 0 and prints `"ok": true`.
- [ ] `node verify.mjs` writes `evidence.json` with `ok: true`.
- [ ] No runtime dependencies.
- [ ] `POLICY` is frozen and matches §2.
- [ ] A dry-run plan cannot be applied.
