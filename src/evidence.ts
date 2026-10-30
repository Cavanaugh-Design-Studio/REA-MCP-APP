import {
  immutableEvidence,
  type Evidence,
} from "./retained/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "./retained/domain/evidenceBundle.js";
import { mergeEvidenceBundleProjections } from "./retained/domain/evidenceBundleProjection.js";
import { Telemetry } from "./telemetry.js";

export class EvidenceStore {
  #bundle: EvidenceBundle = createEvidenceBundle([]);
  constructor(private readonly telemetry = new Telemetry()) {}
  add(raw: unknown): Evidence {
    return this.telemetry.sync("evidence.retain", () => this.#add(raw));
  }
  #add(raw: unknown): Evidence {
    const item = immutableEvidence(raw);
    this.#bundle = createEvidenceBundle(
      [
        ...new Map(
          [...this.#bundle.records, item].map((record) => [
            record.evidence_id,
            record,
          ]),
        ).values(),
      ],
      this.#bundle.unknowns,
    );
    return item;
  }
  get(id: string): Evidence | undefined {
    return this.#bundle.records.find((item) => item.evidence_id === id);
  }
  bundle(): EvidenceBundle {
    return this.#bundle;
  }
  import(raw: unknown): EvidenceBundle {
    const incoming = parseEvidenceBundle(raw);
    this.#bundle = parseEvidenceBundle(
      mergeEvidenceBundleProjections(this.#bundle, incoming),
    );
    return this.#bundle;
  }
}
