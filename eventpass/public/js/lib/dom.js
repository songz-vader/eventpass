// Tiny element builder. Text is always added as text nodes, never parsed as HTML, so a guest called "<img onerror=…>" is just a name.
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'indeterminate', 'readOnly', 'required']);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs !== null && attrs !== undefined && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  const late = [];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (PROPS.has(k)) late.push([k, v]);              // applied after children exist, so <select value> finds its <option>
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  add(el, kids);
  for (const [k, v] of late) el[k] = v;
  return el;
}

export function add(el, kids) {
  for (const k of [kids].flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = (el) => { el.replaceChildren(); return el; };
export const mount = (el, ...kids) => { el.replaceChildren(); add(el, kids); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
