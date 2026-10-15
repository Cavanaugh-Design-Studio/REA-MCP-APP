// Separate candidate implementation of the declared finite behavior; not a benchmark result.
const ui = (id) => document.getElementById(id);
let documentState = { format: 1, zoom: 1, rotation: 0, annotations: [] };
let past = [],
  future = [];
const snapshot = () => JSON.parse(JSON.stringify(documentState));
function repaint(message) {
  ui("semantic").textContent = JSON.stringify(documentState);
  ui("zoom").value = String(documentState.zoom);
  const turn = documentState.rotation;
  ui("paper").style.width =
    `${(turn === 90 || turn === 270 ? 240 : 320) * documentState.zoom}px`;
  ui("paper").style.height =
    `${(turn === 90 || turn === 270 ? 320 : 240) * documentState.zoom}px`;
  ui("markers").replaceChildren();
  for (const note of documentState.annotations) {
    let x = note.x,
      y = note.y;
    if (turn === 90) {
      x = 240 - note.y;
      y = note.x;
    }
    if (turn === 180) {
      x = 320 - note.x;
      y = 240 - note.y;
    }
    if (turn === 270) {
      x = note.y;
      y = 320 - note.x;
    }
    const marker = document.createElement("span");
    marker.className = "annotation";
    marker.style.left = `${x * documentState.zoom}px`;
    marker.style.top = `${y * documentState.zoom}px`;
    ui("markers").append(marker);
  }
  if (message) ui("status").textContent = message;
}
function edit(action) {
  past.push(snapshot());
  future = [];
  action();
  repaint("Updated");
}
ui("apply-zoom").onclick = () => {
  const value = Number(ui("zoom").value);
  if (!Number.isFinite(value) || value < 0.25 || value > 4) {
    repaint("Invalid zoom");
    return;
  }
  edit(() => {
    documentState.zoom = value;
  });
};
ui("rotate").onclick = () =>
  edit(() => {
    documentState.rotation = (documentState.rotation + 90) % 360;
  });
function selectedPoint() {
  let x = Number(ui("x").value) / documentState.zoom,
    y = Number(ui("y").value) / documentState.zoom;
  const turn = documentState.rotation;
  if (turn === 90) [x, y] = [y, 240 - x];
  else if (turn === 180) [x, y] = [320 - x, 240 - y];
  else if (turn === 270) [x, y] = [320 - y, x];
  x = Math.round(x * 1000) / 1000;
  y = Math.round(y * 1000) / 1000;
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
for (const operation of ["place", "move"])
  ui(operation).onclick = () => {
    try {
      const point = selectedPoint();
      if (operation === "move" && !documentState.annotations.length)
        throw new Error("No annotation to move");
      edit(() => {
        if (operation === "place") documentState.annotations.push(point);
        else
          documentState.annotations[documentState.annotations.length - 1] =
            point;
      });
    } catch (error) {
      ui("status").textContent = error.message;
    }
  };
for (const operation of ["undo", "redo"])
  ui(operation).onclick = () => {
    const from = operation === "undo" ? past : future,
      to = operation === "undo" ? future : past;
    if (!from.length) {
      ui("status").textContent =
        operation === "undo" ? "Nothing to undo" : "Nothing to redo";
      return;
    }
    to.push(snapshot());
    documentState = from.pop();
    repaint(operation === "undo" ? "Undone" : "Redone");
  };
ui("save").onclick = () => {
  localStorage.setItem(
    "rea.annotation.document",
    JSON.stringify(documentState),
  );
  ui("status").textContent = "Saved";
};
ui("close").onclick = () => {
  documentState = { format: 1, zoom: 1, rotation: 0, annotations: [] };
  past = [];
  future = [];
  repaint("Closed");
};
ui("reopen").onclick = () => {
  const value = localStorage.getItem("rea.annotation.document");
  if (value) {
    documentState = JSON.parse(value);
    past = [];
    future = [];
    repaint("Reopened");
  } else ui("status").textContent = "No saved document";
};
ui("cancel-save").onclick = () => {
  ui("status").textContent = "Save cancelled";
};
ui("import-document").onclick = () => {
  try {
    const data = JSON.parse(ui("import").value);
    if (
      data.format !== 1 ||
      data.zoom < 0.25 ||
      data.zoom > 4 ||
      !Number.isFinite(data.zoom) ||
      ![0, 90, 180, 270].includes(data.rotation) ||
      !Array.isArray(data.annotations) ||
      data.annotations.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.x > 320 ||
          p.y < 0 ||
          p.y > 240,
      )
    )
      throw new Error();
    edit(() => {
      documentState = {
        format: 1,
        zoom: data.zoom,
        rotation: data.rotation,
        annotations: data.annotations.map((p) => ({ x: p.x, y: p.y })),
      };
    });
  } catch {
    ui("status").textContent = "Invalid document";
  }
};
repaint();
