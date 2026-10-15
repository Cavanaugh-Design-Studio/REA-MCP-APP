// Evaluator-owned reference. Benchmark reconstruction workers must not read this source.
const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [
    element.id,
    element,
  ]),
);
let state = { format: 1, zoom: 1, rotation: 0, annotations: [] };
let undo = [],
  redo = [];
const copy = (value) => structuredClone(value);
const status = (message) => {
  elements.status.textContent = message;
};
const quantize = (value) => Math.round(value * 1000) / 1000;
const project = ({ x, y }) => {
  const points = [
    [x, y],
    [240 - y, x],
    [320 - x, 240 - y],
    [y, 320 - x],
  ];
  return points[state.rotation / 90].map((value) => value * state.zoom);
};
function render() {
  elements.semantic.textContent = JSON.stringify(state);
  elements.zoom.value = String(state.zoom);
  const sideways = state.rotation % 180 !== 0;
  elements.paper.style.width = `${(sideways ? 240 : 320) * state.zoom}px`;
  elements.paper.style.height = `${(sideways ? 320 : 240) * state.zoom}px`;
  elements.markers.replaceChildren(
    ...state.annotations.map((point) => {
      const marker = document.createElement("span");
      marker.className = "annotation";
      const [x, y] = project(point);
      marker.style.left = `${x}px`;
      marker.style.top = `${y}px`;
      return marker;
    }),
  );
}
function change(next) {
  undo.push(copy(state));
  redo = [];
  state = next;
  render();
  status("Updated");
}
function inverse() {
  const a = Number(elements.x.value) / state.zoom,
    b = Number(elements.y.value) / state.zoom;
  const points = [
    [a, b],
    [b, 240 - a],
    [320 - a, 240 - b],
    [320 - b, a],
  ];
  const [x, y] = points[state.rotation / 90].map(quantize);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    y < 0 ||
    x > 320 ||
    y > 240
  )
    throw new Error("Coordinates outside document");
  return { x, y };
}
elements["apply-zoom"].onclick = () => {
  const zoom = Number(elements.zoom.value);
  if (!Number.isFinite(zoom) || zoom < 0.25 || zoom > 4) {
    status("Invalid zoom");
    render();
    return;
  }
  change({ ...copy(state), zoom });
};
elements.rotate.onclick = () =>
  change({ ...copy(state), rotation: (state.rotation + 90) % 360 });
for (const operation of ["place", "move"])
  elements[operation].onclick = () => {
    try {
      const next = copy(state),
        point = inverse();
      if (operation === "place") next.annotations.push(point);
      else {
        if (!next.annotations.length) throw new Error("No annotation to move");
        next.annotations[next.annotations.length - 1] = point;
      }
      change(next);
    } catch (error) {
      status(error.message);
    }
  };
elements.undo.onclick = () => {
  if (!undo.length) {
    status("Nothing to undo");
    return;
  }
  redo.push(copy(state));
  state = undo.pop();
  render();
  status("Undone");
};
elements.redo.onclick = () => {
  if (!redo.length) {
    status("Nothing to redo");
    return;
  }
  undo.push(copy(state));
  state = redo.pop();
  render();
  status("Redone");
};
elements.save.onclick = () => {
  localStorage.setItem("rea.annotation.document", JSON.stringify(state));
  status("Saved");
};
elements.close.onclick = () => {
  state = { format: 1, zoom: 1, rotation: 0, annotations: [] };
  undo = [];
  redo = [];
  render();
  status("Closed");
};
elements.reopen.onclick = () => {
  const saved = localStorage.getItem("rea.annotation.document");
  if (!saved) {
    status("No saved document");
    return;
  }
  state = JSON.parse(saved);
  undo = [];
  redo = [];
  render();
  status("Reopened");
};
elements["cancel-save"].onclick = () => status("Save cancelled");
elements["import-document"].onclick = () => {
  try {
    const value = JSON.parse(elements.import.value);
    if (
      value.format !== 1 ||
      !Array.isArray(value.annotations) ||
      !Number.isFinite(value.zoom) ||
      value.zoom < 0.25 ||
      value.zoom > 4 ||
      ![0, 90, 180, 270].includes(value.rotation) ||
      value.annotations.some(
        (point) =>
          !Number.isFinite(point.x) ||
          !Number.isFinite(point.y) ||
          point.x < 0 ||
          point.y < 0 ||
          point.x > 320 ||
          point.y > 240,
      )
    )
      throw new Error("Invalid document");
    change({
      format: 1,
      zoom: value.zoom,
      rotation: value.rotation,
      annotations: value.annotations.map(({ x, y }) => ({ x, y })),
    });
  } catch {
    status("Invalid document");
  }
};
render();
