// Drag to reorder a vertical list: the rows between a held row and its landing slot slide aside
// to open a gap. The caller marks the draggable rows (draggable="true") and re-renders in onMove.
//   bindReorder(container, { item: selector, onMove: (from, to) => … })  // indexes among the items
//
// Rows are measured once, when the drag starts: where a slide has put them must not move the
// target under the pointer.
export function bindReorder(container, { item, onMove }) {
  let lift = null; // { rows, spots: [{ top, height }], from, at, gap }
  const offset = () => container.getBoundingClientRect().top - container.scrollTop;

  const place = () => {
    const { rows, spots, from, at, gap } = lift;
    const span = (from + 1 < spots.length ? spots[from + 1].top : spots[from].top + spots[from].height + gap) - spots[from].top;
    rows.forEach((row, i) => {
      const shift = at > from && i > from && i <= at ? -span : at < from && i >= at && i < from ? span : 0;
      row.style.transform = shift ? `translateY(${shift}px)` : "";
    });
  };
  const slotAt = (event) => {
    const y = event.clientY - offset();
    const found = lift.spots.findIndex((spot) => y < spot.top + spot.height);
    return found < 0 ? lift.spots.length - 1 : found;
  };
  const end = () => {
    if (lift) lift.rows.forEach((row) => { row.style.transform = ""; row.style.transition = ""; row.classList.remove("lifted"); });
    lift = null;
  };

  container.addEventListener("dragstart", (event) => {
    const row = event.target.closest(item);
    if (!row || !container.contains(row)) return;
    const rows = [...container.querySelectorAll(item)];
    const origin = offset();
    const spots = rows.map((each) => {
      const box = each.getBoundingClientRect();
      return { top: box.top - origin, height: box.height };
    });
    const from = rows.indexOf(row);
    lift = { rows, spots, from, at: from, gap: spots.length > 1 ? Math.max(0, spots[1].top - spots[0].top - spots[0].height) : 0 };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", row.textContent.trim());
    // Hide the held row once the browser has taken its drag picture of it.
    setTimeout(() => {
      if (!lift) return;
      rows.forEach((each) => { each.style.transition = "transform .16s ease"; });
      row.classList.add("lifted");
    }, 0);
  });
  // Rows sliding under a still pointer make the browser enter a new element: accept it too.
  container.addEventListener("dragenter", (event) => { if (lift) event.preventDefault(); });
  container.addEventListener("dragover", (event) => {
    if (!lift) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const at = slotAt(event);
    if (at === lift.at) return;
    lift.at = at;
    place();
  });
  container.addEventListener("drop", (event) => {
    if (!lift) return;
    const { from, at } = lift;
    end();
    event.preventDefault();
    if (at !== from) onMove(from, at);
  });
  container.addEventListener("dragend", end);
}
