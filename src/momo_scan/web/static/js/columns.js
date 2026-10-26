// Drag to resize and reorder the columns of a list header (the watchlist and the scan list).
// Header cells carry data-col; cells without it (the flag, the spare room) stay put.

const MIN = 44;
const MAX = 220;

// The grip sits on the edge that moves: the right edge of columns before the flexible one,
// the left edge of columns after it. `dir` is which way dragging grows the column.
export const gripHtml = (afterFlex) =>
  `<i class="col-grip ${afterFlex ? "l" : "r"}" data-dir="${afterFlex ? -1 : 1}"></i>`;

// `room` (optional) says how many more pixels the header can give a column before the flexible
// one (Symbol) is squeezed too small.
export function bindColumns(header, { width, setWidth, move, room }) {
  let dragging = null;

  header.addEventListener("pointerdown", (event) => {
    const grip = event.target.closest(".col-grip");
    if (!grip || event.button) return;
    const cell = grip.closest("[data-col]");
    event.preventDefault();
    event.stopPropagation();
    grip.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, key: cell.dataset.col, wide: cell.getBoundingClientRect().width, dir: Number(grip.dataset.dir) };
    const max = Math.min(MAX, start.wide + (room ? Math.max(0, room()) : Infinity));
    const drag = (e) => setWidth(start.key, Math.round(Math.min(max, Math.max(MIN, start.wide + (e.clientX - start.x) * start.dir))), false);
    const stop = (e) => {
      grip.removeEventListener("pointermove", drag);
      grip.removeEventListener("pointerup", stop);
      grip.removeEventListener("pointercancel", stop);
      header.classList.remove("resizing");
      setWidth(start.key, width(start.key), true);
    };
    header.classList.add("resizing");
    grip.addEventListener("pointermove", drag);
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  });
  // A double-click on the grip puts the column back to its default width.
  header.addEventListener("dblclick", (event) => {
    const grip = event.target.closest(".col-grip");
    if (grip) setWidth(grip.closest("[data-col]").dataset.col, null, true);
  });
  // Don't let the end of a resize count as a click on the header (it would sort).
  header.addEventListener("click", (event) => {
    if (event.target.closest(".col-grip")) event.stopPropagation();
  }, true);

  header.addEventListener("dragstart", (event) => {
    const cell = event.target.closest("[data-col]");
    if (!cell) return event.preventDefault();
    dragging = cell.dataset.col;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragging);
    cell.classList.add("dragging");
  });
  header.addEventListener("dragover", (event) => {
    const cell = event.target.closest("[data-col]");
    header.querySelectorAll(".drop").forEach((item) => item.classList.remove("drop"));
    if (!dragging || !cell || cell.dataset.col === dragging) return;
    event.preventDefault();
    cell.classList.add("drop");
  });
  header.addEventListener("drop", (event) => {
    const cell = event.target.closest("[data-col]");
    if (!dragging || !cell || cell.dataset.col === dragging) return;
    event.preventDefault();
    move(dragging, cell.dataset.col);
  });
  header.addEventListener("dragend", () => {
    dragging = null;
    header.querySelectorAll(".dragging, .drop").forEach((item) => item.classList.remove("dragging", "drop"));
  });
}

// Take `key` out of `order` and put it where `target` was.
export function moved(order, key, target) {
  const rest = order.filter((item) => item !== key);
  rest.splice(order.indexOf(target), 0, key);
  return rest;
}
