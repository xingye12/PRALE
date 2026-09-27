// Minimal DOM building. Payload text always goes through textContent, never
// through innerHTML: entries, memory content and skill bodies are untrusted.

export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "value") node.value = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

/** Accepts a node, an array (possibly nested), or either nested further. */
export function append(parent, children) {
  for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
    if (child === null || child === undefined || child === false || child === "") continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function badge(label, tone = "pending", title) {
  return h("span", { class: "badge", dataset: { tone }, title, text: label });
}

export function tag(text) {
  return h("span", { class: "tag", text });
}

export function kv(entries) {
  const list = h("dl", { class: "grid-kv" });
  for (const [name, value] of entries) {
    if (value === null || value === undefined) continue;
    append(list, [h("dt", { text: name }), h("dd", {}, value)]);
  }
  return list;
}

export function card(children, { head, selected, onClick } = {}) {
  const node = h(
    "section",
    { class: onClick ? "card clickable" : "card", dataset: selected ? { selected: "true" } : {} },
    head ? h("div", { class: "card-head" }, head) : null,
    h("div", { class: "card-body" }, children),
  );
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

export function table(columns, rows) {
  if (!rows.length) return h("p", { class: "meta", text: "没有记录。" });
  const head = h("tr", {}, columns.map((column) => h("th", { text: column.label })));
  const body = rows.map(
    (row) => h("tr", {}, columns.map((column) => h("td", {}, column.render(row)))),
  );
  return h("table", { class: "data" }, h("thead", {}, head), h("tbody", {}, body));
}

export function empty(title, detail) {
  return h("div", { class: "empty" }, h("strong", { text: title }), detail ? h("p", { text: detail }) : null);
}

export function notice(message, tone = "warn") {
  return h("div", { class: "notice", dataset: { tone }, text: message });
}

export function tabs(items, active, onSelect) {
  return h(
    "div",
    { class: "tabs" },
    items.map((item) =>
      h("button", {
        type: "button",
        text: item.label,
        dataset: { active: String(item.id === active) },
        onClick: () => onSelect(item.id),
      }),
    ),
  );
}

export function sectionTitle(text) {
  return h("h3", { class: "section-title", text });
}
