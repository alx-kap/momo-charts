import { escapeHtml, store } from "./util.js";

// Confirmations and questions in the app's own style, in place of the browser's boxes. Both
// return a promise: `confirmDialog` true or false, `promptDialog` the text or null if cancelled.
//   confirmDialog({ title, message?, ok?, danger? })
//   promptDialog({ title, message?, value?, placeholder?, ok?, multiline?, hint? })
// Enter accepts (Ctrl+Enter in a multi-line box), Esc or a click outside cancels.

let open = null;

function show({ title, message, ok = "OK", danger = false, field = null, hint = "" }) {
  if (open) open.finish(null);
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dlg-back";
    const input = field && (field.multiline ? document.createElement("textarea") : document.createElement("input"));
    back.innerHTML = `<div class="dlg" role="dialog" aria-modal="true">` +
      `<div class="dlg-title">${escapeHtml(title)}</div>` +
      (message ? `<div class="dlg-text">${escapeHtml(message)}</div>` : "") +
      `<div class="dlg-field"></div>` +
      (hint ? `<div class="dlg-hint">${escapeHtml(hint)}</div>` : "") +
      `<div class="dlg-buttons"><button class="dlg-cancel">Cancel</button>` +
      `<button class="dlg-ok${danger ? " danger" : ""}">${escapeHtml(ok)}</button></div></div>`;
    if (input) {
      Object.assign(input, { value: field.value || "", placeholder: field.placeholder || "", spellcheck: false, autocomplete: "off" });
      if (field.multiline) input.rows = 6;
      back.querySelector(".dlg-field").append(input);
    }
    const opener = document.activeElement;
    const finish = (result) => {
      if (open !== api) return;
      open = null;
      back.remove();
      document.removeEventListener("keydown", onKey, true);
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
      resolve(result);
    };
    const accept = () => finish(input ? input.value : true);
    const onKey = (event) => {
      if (event.key === "Escape") finish(input ? null : false);
      else if (event.key === "Enter" && !(input && field.multiline && !event.ctrlKey && !event.metaKey)) accept();
      else if (event.key === "Tab") return; // stays inside: the dialog is the only thing with buttons
      else if (!event.metaKey && !event.ctrlKey && event.target === document.body) return;
      else return event.stopPropagation(); // typing here doesn't reach the app's hotkeys
      event.preventDefault();
      event.stopPropagation();
    };
    const api = { finish };
    open = api;
    back.addEventListener("pointerdown", (event) => { if (event.target === back) finish(input ? null : false); });
    back.querySelector(".dlg-cancel").addEventListener("click", () => finish(input ? null : false));
    back.querySelector(".dlg-ok").addEventListener("click", accept);
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    (input || back.querySelector(".dlg-ok")).focus();
    if (input) input.select();
  });
}

export const confirmDialog = (options) => show(options);
export const promptDialog = ({ value, placeholder, multiline, ...rest }) => show({ ...rest, field: { value, placeholder, multiline } });

// The same pointer capture and drag lifecycle for toolbars and floating cards.
export const FLOAT_GRIP = '<svg width="8" height="16" viewBox="0 0 8 16" fill="currentColor"><circle cx="2" cy="3" r="1.2"/><circle cx="6" cy="3" r="1.2"/><circle cx="2" cy="8" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="2" cy="13" r="1.2"/><circle cx="6" cy="13" r="1.2"/></svg>';

export function bindFloatDrag(el, { grip, position, save }) {
  el.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(grip);
    if (!handle || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const from = { x: event.clientX - el.offsetLeft, y: event.clientY - el.offsetTop };
    handle.setPointerCapture(event.pointerId);
    el.classList.add("dragging");
    const move = (e) => position({ x: e.clientX - from.x, y: e.clientY - from.y });
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      el.classList.remove("dragging");
      save({ x: el.offsetLeft, y: el.offsetTop });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

export function floatingCard(el, key, grip, initial) {
  let place = store.get(key, null);
  const position = (next) => {
    if (next) place = next;
    if (el.hidden) return;
    const at = place || initial();
    el.style.left = `${Math.max(4, Math.min(at.x, innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, innerHeight - el.offsetHeight - 4))}px`;
  };
  bindFloatDrag(el, { grip, position, save: (at) => { place = at; store.set(key, at); } });
  window.addEventListener("resize", () => position());
  new ResizeObserver(() => position()).observe(el);
  return () => position();
}
