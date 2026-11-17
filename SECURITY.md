# Security

## Threat model

The dangerous operation is deletion. The untrusted inputs are table contents, timestamps and the
reference list supplied by the caller. A wrong plan must not be able to erase live data silently.

Mitigations in this repository:

- planning and applying are separate calls, and `applyRetention` refuses a plan with
  `dryRun !== false` (`DRY_RUN`);
- `verifyPlan` rejects duplicate deletes and delete/blocked overlap before mutation;
- a target referenced by a live row is blocked, and the block cascades to a fixpoint;
- the cutoff is strict (`<`), so a row exactly at the boundary survives;
- `applyRetention` returns actual removed counts, so a caller can compare them with the plan;
- no network, no dependencies, no environment reads, no dynamic code.

## Known limits

- The reference list is trusted input. If the caller omits a real foreign key, the plan can delete a
  parent row. The planner cannot discover references it was not told about.
- `applyRetention` mutates the arrays in place. It is not transactional and has no rollback. Run it
  inside a database transaction in production, or use the plan to issue batched deletes.
- Backups, replicas and analytics copies are outside this module. Retention is not complete until
  every copy expires under the same policy.
- Partitions are dropped by month label; there is no clock skew handling beyond the supplied `now`.

## Reporting

Open a private security advisory on the repository. Do not file a public issue with a working path
to deleting a live row.
