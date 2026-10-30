import type { Evidence } from "../src/retained/domain/evidence.js";
const escape = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
let selected = "",
  filter = "",
  offset = 0;
const pageSize = 50;
export function renderAnalysisGraphs(records: Iterable<Evidence>): string {
  const sources = [...records].filter((record) => {
    const graph = object(object(record.normalized_result).graph);
    return Array.isArray(graph.nodes) && Array.isArray(graph.edges);
  });
  if (!sources.length)
    return '<section class="panel"><h2>Analysis relationships</h2><p class="muted">Retain a JavaScript application analysis or managed graph to inspect its nodes, relationships and unresolved coverage.</p></section>';
  const source =
    sources.find((record) => record.evidence_id === selected) ?? sources[0]!;
  selected = source.evidence_id;
  const result = object(source.normalized_result),
    graph = object(result.graph),
    nodes = (graph.nodes as unknown[]).map(object),
    edges = (graph.edges as unknown[]).map(object);
  const labels = new Map(
    nodes.map((node) => [
      node.node_id,
      String(
        object((node.observations as unknown[] | undefined)?.[0]).label ??
          node.kind ??
          node.node_id,
      ),
    ]),
  );
  const rows = edges.map((edge) => {
    const observations = Array.isArray(edge.observations)
      ? edge.observations.map((item) => object(object(item).evidence))
      : [object(edge.evidence)];
    const basis =
      [
        ...new Set(
          observations
            .map((item) =>
              [item.state, item.confidence, item.authority]
                .filter(Boolean)
                .join(" / "),
            )
            .filter(Boolean),
        ),
      ].join("; ") || source.confidence;
    return {
      source: labels.get(edge.source_node_id) ?? edge.source_node_id,
      target: labels.get(edge.target_node_id) ?? edge.target_node_id,
      relation: edge.relation ?? edge.kind,
      evidence: { authority: basis, confidence: source.confidence },
      id: edge.edge_id,
    };
  });
  const matching = rows.filter((row) =>
      JSON.stringify(row).toLowerCase().includes(filter.toLowerCase()),
    ),
    page = matching.slice(offset, offset + pageSize);
  return `<section class="panel"><div class="panel-head"><h2>Analysis relationships</h2><small>${nodes.length} nodes · ${edges.length} relationships · ${escape(source.confidence)}</small></div><label for="analysis-graph">Source analysis</label><select id="analysis-graph">${sources.map((record) => `<option value="${escape(record.evidence_id)}" ${record === source ? "selected" : ""}>${escape(record.operation)} · ${escape(record.evidence_id.slice(0, 19))}</option>`).join("")}</select><label for="graph-filter">Filter relationships</label><input id="graph-filter" value="${escape(filter)}" placeholder="Module, method, relation or unresolved state"><p class="muted">${escape(JSON.stringify(result.coverage ?? graph.coverage ?? {}))}</p><div class="table-scroll"><table><thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Evidence basis</th></tr></thead><tbody>${page.map((row) => `<tr><td>${escape(row.source)}</td><td>${escape(row.relation)}</td><td>${escape(row.target)}</td><td>${escape(row.evidence.authority ?? row.evidence.confidence ?? source.confidence)}</td></tr>`).join("")}</tbody></table></div><div class="tabs"><button id="graph-prev" ${offset === 0 ? "disabled" : ""}>Previous</button><small>${offset + (page.length ? 1 : 0)}–${offset + page.length} of ${matching.length}</small><button id="graph-next" ${offset + pageSize >= matching.length ? "disabled" : ""}>Next</button></div><details><summary>Coverage and limitations</summary><pre class="code">${escape(JSON.stringify({ coverage: result.coverage ?? graph.coverage ?? null, limitations: source.limitations }, null, 2))}</pre></details></section>`;
}
export function bindAnalysisGraphs(render: () => void): void {
  document
    .getElementById("analysis-graph")
    ?.addEventListener("change", (event) => {
      selected = (event.target as HTMLSelectElement).value;
      offset = 0;
      render();
    });
  document
    .getElementById("graph-filter")
    ?.addEventListener("change", (event) => {
      filter = (event.target as HTMLInputElement).value;
      offset = 0;
      render();
    });
  document.getElementById("graph-prev")?.addEventListener("click", () => {
    offset = Math.max(0, offset - pageSize);
    render();
  });
  document.getElementById("graph-next")?.addEventListener("click", () => {
    offset += pageSize;
    render();
  });
}
