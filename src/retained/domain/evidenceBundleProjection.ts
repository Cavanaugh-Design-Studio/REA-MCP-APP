import type { EvidenceBundle } from "./evidenceBundle.js";
import type { Evidence } from "./evidence.js";
import type { ResidualUnknown } from "./residualUnknown.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Project records into a deterministic bundle whose order has no semantics. */
export const createEvidenceBundle = (
  records: readonly Evidence[],
  unknowns: readonly ResidualUnknown[] = [],
): EvidenceBundle => {
  const sortedRecords = [...records].sort((left, right) =>
    compareUnicodeCodePoints(left.evidence_id, right.evidence_id),
  );
  return {
    artifacts: uniqueSorted(
      sortedRecords.flatMap(({ subject }) =>
        subject === null
          ? []
          : [
              {
                digest: subject.digest,
                format: subject.format,
                architecture: subject.architecture,
              },
            ],
      ),
    ),
    providers: uniqueSorted(sortedRecords.map(({ provider }) => provider)),
    environments: uniqueSorted(
      sortedRecords.flatMap(({ environment }) =>
        environment === null ? [] : [environment],
      ),
    ),
    scenarios: sortedRecords.flatMap((evidence) =>
      evidence.authority === "controlled-replay"
        ? [
            {
              evidence_id: evidence.evidence_id,
              operation: evidence.operation,
              authority: evidence.authority,
            },
          ]
        : [],
    ),
    captures: sortedRecords.flatMap((evidence) =>
      evidence.predicate_type === "rea.process-capture"
        ? [
            {
              evidence_id: evidence.evidence_id,
              predicate_type: evidence.predicate_type,
            },
          ]
        : [],
    ),
    unknowns: [...unknowns].sort(
      (left, right) =>
        compareUnicodeCodePoints(left.unknown_id, right.unknown_id) ||
        left.revision - right.revision,
    ),
    records: sortedRecords,
  };
};

const uniqueSorted = <Value>(values: readonly Value[]): Value[] => {
  const unique = new Map<string, Value>();
  for (const value of values) unique.set(JSON.stringify(value), value);
  return [...unique.entries()]
    .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    .map(([, value]) => value);
};

/** Merge explicit portable bundles without losing retained records or unknown histories.
 * Authentication remains the owning server boundary's responsibility. */
export const mergeEvidenceBundleProjections = (
  ...bundles: readonly EvidenceBundle[]
): EvidenceBundle => {
  const records = new Map<string, Evidence>();
  const unknowns = new Map<string, ResidualUnknown>();
  for (const bundle of bundles) {
    for (const record of bundle.records)
      records.set(record.evidence_id, record);
    for (const unknown of bundle.unknowns) {
      const key = `${unknown.unknown_id}:${unknown.revision}`;
      const existing = unknowns.get(key);
      if (existing && existing.revision_digest !== unknown.revision_digest)
        throw new TypeError("Conflicting retained unknown revisions");
      unknowns.set(key, unknown);
    }
  }
  return createEvidenceBundle([...records.values()], [...unknowns.values()]);
};
