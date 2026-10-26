import { escapeHtml } from "./util.js";

// A styled dropdown in place of the browser's <select>. Grouped lists get a search box.
//   pickOption(anchor, { groups: [{ label?, items: [{ value, label, hint? }] }], current?, search? })
// resolves to the chosen value, or null if dismissed. Typing filters; ↑ ↓ Enter and Esc work.
let open = null;

export function pickOption(anchor, { groups, current, search = false }) {
  open?.close(null);
  return new Promise((resolve) => {
    const title = anchor.getAttribute("title");  // a tooltip would sit on top of the menu
    anchor.removeAttribute("title");
    const menu = document.createElement("div");
    menu.className = "pick-menu";
    menu.innerHTML = (search ? `<input class="pick-search" type="text" placeholder="Search filters…" spellcheck="false" autocomplete="off">` : "") +
      `<div class="pick-list"></div>`;
    const list = menu.querySelector(".pick-list");
    const input = menu.querySelector(".pick-search");
    let query = "";
    let cursor = 0;

    const visible = () => groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => {
        const hay = `${item.label} ${item.hint || ""} ${group.label || ""}`.toLowerCase();
        return query.split(/\s+/).every((word) => hay.includes(word));
      }),
    })).filter((group) => group.items.length);

    const render = () => {
      const shown = visible();
      const flat = shown.flatMap((group) => group.items);
      cursor = Math.max(0, Math.min(cursor, flat.length - 1));
      list.innerHTML = flat.length ? shown.map((group) =>
        (group.label ? `<div class="pick-group">${escapeHtml(group.label)}</div>` : "") +
        group.items.map((item) => `<button type="button" class="pick-item${item.value === current ? " on" : ""}${flat[cursor] === item ? " cur" : ""}" data-value="${escapeHtml(String(item.value))}">${
          escapeHtml(item.label)}${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ""}</button>`).join("")).join("")
        : `<div class="pick-empty">No filter matches “${escapeHtml(query)}”</div>`;
      list.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
      return flat;
    };

    const close = (value) => {
      if (open?.menu !== menu) return;
      open = null;
      document.removeEventListener("mousedown", away, true);
      window.removeEventListener("resize", dismiss);
      menu.remove();
      if (title) anchor.setAttribute("title", title);
      anchor.focus?.({ preventScroll: true });
      resolve(value);
    };
    const dismiss = () => close(null);
    const away = (event) => { if (!menu.contains(event.target) && !anchor.contains(event.target)) close(null); };
    const choose = (flat) => flat[cursor] && close(flat[cursor].value);

    list.addEventListener("click", (event) => {
      const item = event.target.closest(".pick-item");
      if (item) close(groups.flatMap((group) => group.items).find((entry) => String(entry.value) === item.dataset.value).value);
    });
    list.addEventListener("mousemove", (event) => {
      const item = event.target.closest(".pick-item");
      if (!item || item.classList.contains("cur")) return;
      list.querySelector(".cur")?.classList.remove("cur");
      item.classList.add("cur");
      cursor = [...list.querySelectorAll(".pick-item")].indexOf(item);
    });
    menu.addEventListener("keydown", (event) => {
      const flat = visible().flatMap((group) => group.items);
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return close(null); }
      if (event.key === "Enter") { event.preventDefault(); return choose(flat); }
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      cursor = (cursor + step + flat.length) % flat.length;
      render();
    });
    input?.addEventListener("input", () => { query = input.value.trim().toLowerCase(); cursor = 0; render(); });

    document.body.appendChild(menu);
    open = { menu, close };
    const flat = render();
    cursor = Math.max(0, flat.findIndex((item) => item.value === current));
    render();

    const box = anchor.getBoundingClientRect();
    const width = Math.max(box.width, search ? 260 : 120);
    const below = innerHeight - box.bottom - 12;
    const up = below < 220 && box.top > below;
    Object.assign(menu.style, {
      left: `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`,
      width: `${width}px`,
      ...(up ? { bottom: `${innerHeight - box.top + 4}px` } : { top: `${box.bottom + 4}px` }),
      maxHeight: `${Math.max(160, Math.min(380, (up ? box.top : below) - 8))}px`,
    });
    document.addEventListener("mousedown", away, true);
    window.addEventListener("resize", dismiss);
    menu.tabIndex = -1;
    (input || menu).focus({ preventScroll: true });
  });
}
