// SPDX-License-Identifier: MIT
/**
 * retention-job — delete by policy, prove it with a dry run first.
 *
 * `planRetention` is pure: it reads tables and returns exactly what would be
 * deleted, what is blocked by a live reference, and which month partitions
 * would be dropped. `applyRetention` refuses to run on a dry-run plan, so the
 * only way to delete is to build a plan with `dryRun: false` first.
 */

const DAY_MS = 86_400_000;

export const POLICY = Object.freeze({
  runs: 90,
  tutor_messages: 30,
  tutor_messages_adult: 90,
  ai_usage_hourly: 365,
  progress_events_months: 24,
  sessions: 30,
});

const ROW_TABLES = Object.freeze(['runs', 'tutor_messages', 'ai_usage_hourly', 'sessions']);
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function monthIndex(month) {
  const match = MONTH_RE.exec(String(month));
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]);
  if (index < 1 || index > 12) return null;
  return year * 12 + (index - 1);
}

function ttlFor(table, row) {
  if (table === 'tutor_messages') {
    return row.ageBand === 'minor' ? POLICY.tutor_messages : POLICY.tutor_messages_adult;
  }
  return POLICY[table];
}

/**
 * @param {{
 *   tables: Record<string, any>,
 *   now: number,
 *   dryRun?: boolean,
 *   references?: Array<{ table: string, id: string, referencedBy: { table: string, id: string } }>
 * }} input
 */
export function planRetention(input = {}) {
  const { tables, now, dryRun = true, references = [] } = input;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    throw fail('INVALID_TABLES', 'tables must be an object of table name -> rows');
  }
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw fail('INVALID_NOW', 'now must be a finite epoch milliseconds number');
  }
  if (!Array.isArray(references)) {
    throw fail('INVALID_REFERENCES', 'references must be an array');
  }

  const rowsByTable = new Map();
  const index = new Map();
  const candidates = new Map();
  const counts = {};

  for (const table of ROW_TABLES) {
    const rows = tables[table] ?? [];
    if (!Array.isArray(rows)) {
      throw fail('INVALID_TABLE', `${table} must be an array of rows`);
    }
    rowsByTable.set(table, rows);
    const byId = new Map();
    const deletable = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length === 0) {
        throw fail('INVALID_ROW', `${table} contains a row without a string id`);
      }
      if (!byId.has(row.id)) byId.set(row.id, row);
      const createdAt = row.createdAt;
      if (typeof createdAt === 'number' && Number.isFinite(createdAt)) {
        const cutoff = now - ttlFor(table, row) * DAY_MS;
        if (createdAt < cutoff) deletable.add(row.id);
      }
    }
    index.set(table, byId);
    candidates.set(table, deletable);
    counts[table] = { total: rows.length, delete: 0, blocked: 0, kept: rows.length };
  }

  const blockedReason = new Map();
  const blockedOrder = [];

  // A row referenced by a live row stays. Removing a candidate can make its
  // referrer live, so replay until nothing changes.
  let changed = true;
  while (changed) {
    changed = false;
    for (const ref of references) {
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') {
        throw fail('INVALID_REFERENCE', 'each reference needs { table, id, referencedBy }');
      }
      const from = ref.referencedBy;
      if (!from || typeof from !== 'object' || typeof from.id !== 'string') {
        throw fail('INVALID_REFERENCE', 'each reference needs a referencedBy row');
      }
      const deletable = candidates.get(ref.table);
      if (!deletable || !deletable.has(ref.id)) continue;
      const referrer = index.get(from.table)?.get(from.id);
      if (!referrer) continue; // dangling references do not protect a row
      if (candidates.get(from.table)?.has(from.id)) continue; // referrer goes too
      deletable.delete(ref.id);
      const key = `${ref.table}\u0000${ref.id}`;
      if (!blockedReason.has(key)) {
        blockedReason.set(key, `referenced by ${from.table}:${from.id}`);
        blockedOrder.push({ table: ref.table, id: ref.id, reason: blockedReason.get(key) });
      }
      changed = true;
    }
  }

  const deletes = [];
  const blocked = [];
  let kept = 0;

  for (const table of ROW_TABLES) {
    const rows = rowsByTable.get(table);
    const seen = new Set();
    const blockedIds = new Set(
      blockedOrder.filter((entry) => entry.table === table).map((entry) => entry.id),
    );
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (candidates.get(table).has(row.id)) {
        deletes.push({ table, id: row.id });
      } else if (blockedIds.has(row.id)) {
        const reason = blockedOrder.find((e) => e.table === table && e.id === row.id).reason;
        blocked.push({ table, id: row.id, reason });
      }
    }
    counts[table].delete = deletes.filter((d) => d.table === table).length;
    counts[table].blocked = blocked.filter((b) => b.table === table).length;
    counts[table].kept = counts[table].total - counts[table].delete;
    kept += counts[table].kept;
  }

  const partitionsDropped = [];
  const progress = tables.progress_events;
  if (progress && typeof progress === 'object' && !Array.isArray(progress) && Array.isArray(progress.partitions)) {
    const current = new Date(now);
    const currentIndex = current.getUTCFullYear() * 12 + current.getUTCMonth();
    for (const partition of progress.partitions) {
      const indexOfMonth = monthIndex(partition?.month);
      if (indexOfMonth === null) {
        throw fail('INVALID_PARTITION', 'partition months must look like 2024-01');
      }
      if (indexOfMonth < currentIndex - POLICY.progress_events_months) {
        partitionsDropped.push({ table: 'progress_events', month: partition.month });
      }
    }
  }

  return {
    dryRun: Boolean(dryRun),
    delete: deletes,
    blocked,
    kept,
    partitionsDropped,
    counts,
  };
}

/**
 * Mutates the arrays in `tables`, removing planned ids. A dry-run plan is
 * refused so a preview can never be mistaken for an approval.
 */
export function applyRetention(input = {}) {
  const { tables, plan } = input;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    throw fail('INVALID_TABLES', 'tables must be an object of table name -> rows');
  }
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.delete)) {
    throw fail('INVALID_PLAN', 'plan must be the object returned by planRetention');
  }
  if (plan.dryRun !== false) {
    throw fail('DRY_RUN', 'refusing to apply a plan that was not built with dryRun: false');
  }
  verifyPlan(plan);

  const byTable = {};
  for (const entry of plan.delete) {
    const rows = tables[entry.table];
    if (!Array.isArray(rows)) {
      throw fail('INVALID_TABLE', `${entry.table} is missing or not an array`);
    }
    const ids = byTable[entry.table] ?? new Set();
    ids.add(entry.id);
    byTable[entry.table] = ids;
  }

  let deleted = 0;
  const deletedByTable = {};
  for (const [table, ids] of Object.entries(byTable)) {
    const rows = tables[table];
    const before = rows.length;
    rows.splice(0, rows.length, ...rows.filter((row) => !ids.has(row?.id)));
    const removed = before - rows.length;
    deleted += removed;
    deletedByTable[table] = removed;
  }

  const dropped = [];
  const progress = tables.progress_events;
  if (Array.isArray(plan.partitionsDropped) && plan.partitionsDropped.length > 0) {
    if (!progress || !Array.isArray(progress.partitions)) {
      throw fail('INVALID_TABLE', 'plan drops partitions but progress_events.partitions is missing');
    }
    const months = new Set(plan.partitionsDropped.map((entry) => entry.month));
    const before = progress.partitions.length;
    progress.partitions.splice(
      0,
      progress.partitions.length,
      ...progress.partitions.filter((partition) => !months.has(partition?.month)),
    );
    for (const entry of plan.partitionsDropped) {
      dropped.push({ table: 'progress_events', month: entry.month });
    }
    deletedByTable.progress_events = before - progress.partitions.length;
  }

  return { deleted, byTable: deletedByTable, partitionsDropped: dropped };
}

/** Refuses a plan with duplicated deletes or a delete/blocked overlap. */
export function verifyPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw fail('INVALID_PLAN', 'plan must be an object');
  }
  if (!Array.isArray(plan.delete) || !Array.isArray(plan.blocked)) {
    throw fail('INVALID_PLAN', 'plan.delete and plan.blocked must be arrays');
  }
  const deleteKeys = new Set();
  for (const entry of plan.delete) {
    if (!entry || typeof entry.table !== 'string' || typeof entry.id !== 'string') {
      throw fail('INVALID_PLAN', 'each delete entry needs { table, id }');
    }
    const key = `${entry.table}\u0000${entry.id}`;
    if (deleteKeys.has(key)) {
      throw fail('DUPLICATE_DELETE', `duplicate delete for ${entry.table}:${entry.id}`);
    }
    deleteKeys.add(key);
  }
  for (const entry of plan.blocked) {
    if (!entry || typeof entry.table !== 'string' || typeof entry.id !== 'string') {
      throw fail('INVALID_PLAN', 'each blocked entry needs { table, id }');
    }
    if (deleteKeys.has(`${entry.table}\u0000${entry.id}`)) {
      throw fail('DELETE_AND_BLOCKED', `${entry.table}:${entry.id} is both deleted and blocked`);
    }
  }
  return true;
}
