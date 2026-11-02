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

  // While a column is held the others slide aside to open its landing slot. Cells are measured
  // once, at the start: where a slide has put them must not move the target under the pointer.
  let lift = null; // { cells: the draggable cells, spots: [{ left, width }], from, at, gap }
  const place = () => {
    const { cells, spots, from, at, gap } = lift;
    const span = (from + 1 < spots.length ? spots[from + 1].left : spots[from].left + spots[from].width + gap) - spots[from].left;
    cells.forEach((cell, i) => {
      const shift = at > from && i > from && i <= at ? -span : at < from && i >= at && i < from ? span : 0;
      cell.style.transform = shift ? `translateX(${shift}px)` : "";
    });
  };
  const slotAt = (event) => {
    const x = event.clientX - header.getBoundingClientRect().left;
    const { spots } = lift;
    const found = spots.findIndex((spot) => x < spot.left + spot.width);
    return found < 0 ? spots.length - 1 : found;
  };
  const endDrag = () => {
    dragging = null;
    if (lift) lift.cells.forEach((cell) => { cell.style.transform = ""; cell.classList.remove("lifted"); });
    lift = null;
    header.classList.remove("reordering");
  };
  header.addEventListener("dragstart", (event) => {
    const cell = event.target.closest("[data-col]");
    if (!cell) return event.preventDefault();
    dragging = cell.dataset.col;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragging);
    const origin = header.getBoundingClientRect().left;
    const cells = [...header.querySelectorAll("[data-col][draggable=true]")];
    const spots = cells.map((each) => {
      const box = each.getBoundingClientRect();
      return { left: box.left - origin, width: box.width };
    });
    const from = cells.indexOf(cell);
    lift = { cells, spots, from, at: from, gap: spots.length > 1 ? Math.max(0, spots[1].left - spots[0].left - spots[0].width) : 0 };
    // Hide the held header once the browser has taken its drag picture of it.
    setTimeout(() => {
      if (!lift) return;
      header.classList.add("reordering");
      cell.classList.add("lifted");
    }, 0);
  });
  // Cells sliding under a still pointer make the browser enter a new element: accept it too.
  header.addEventListener("dragenter", (event) => { if (lift) event.preventDefault(); });
  header.addEventListener("dragover", (event) => {
    if (!lift) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const at = slotAt(event);
    if (at === lift.at) return;
    lift.at = at;
    place();
  });
  header.addEventListener("drop", (event) => {
    if (!lift) return;
    const { cells, from, at } = lift;
    const key = dragging;
    const target = cells[at].dataset.col;
    endDrag();
    if (at === from) return;
    event.preventDefault();
    move(key, target);
  });
  header.addEventListener("dragend", endDrag);
}

// Take `key` out of `order` and put it where `target` was.
export function moved(order, key, target) {
  const rest = order.filter((item) => item !== key);
  rest.splice(order.indexOf(target), 0, key);
  return rest;
}
