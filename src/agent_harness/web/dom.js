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

/**
 * Render the small, common Markdown subset used by assistant messages.
 *
 * This intentionally builds DOM nodes rather than assigning HTML: model output
 * is untrusted, so a markdown-looking ``<script>`` remains literal text.
 */
export function markdown(text) {
  const root = h("div", { class: "markdown" });
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const fence = line.match(/^```([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      root.append(h("pre", { class: "block" }, h("code", { text: code.join("\n") })));
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      root.append(h(`h${heading[1].length}`, {}, inlineMarkdown(heading[2])));
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      root.append(h("hr"));
      index += 1;
      continue;
    }
    const list = line.match(/^\s*([-*+])\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (list || ordered) {
      const pattern = list ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(h("li", {}, inlineMarkdown(item[1])));
        index += 1;
      }
      root.append(h(list ? "ul" : "ol", {}, items));
      continue;
    }
    if (line.startsWith(">")) {
      const quote = [];
      while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
      root.append(h("blockquote", {}, inlineMarkdown(quote.join("\n"))));
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^```/.test(lines[index])) paragraph.push(lines[index++]);
    root.append(h("p", {}, inlineMarkdown(paragraph.join("\n"))));
  }
  return root;
}

function inlineMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const token = /(`[^`]*`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  for (const match of text.matchAll(token)) {
    appendInlineText(fragment, text.slice(last, match.index));
    const [raw, , linkText, href, boldA, boldB, emphasisA, emphasisB] = match;
    if (raw.startsWith("`")) fragment.append(h("code", { text: raw.slice(1, -1) }));
    else if (linkText !== undefined && safeHref(href)) {
      fragment.append(h("a", { href, target: "_blank", rel: "noopener noreferrer" }, inlineMarkdown(linkText)));
    } else if (boldA !== undefined || boldB !== undefined) fragment.append(h("strong", {}, inlineMarkdown(boldA ?? boldB)));
    else if (emphasisA !== undefined || emphasisB !== undefined) fragment.append(h("em", {}, inlineMarkdown(emphasisA ?? emphasisB)));
    else appendInlineText(fragment, raw);
    last = (match.index || 0) + raw.length;
  }
  appendInlineText(fragment, text.slice(last));
  return fragment;
}

function appendInlineText(parent, text) {
  const parts = text.split("\n");
  parts.forEach((part, index) => {
    if (index) parent.append(h("br"));
    if (part) parent.append(document.createTextNode(part));
  });
}

function safeHref(value) {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value, window.location.origin).protocol);
  } catch {
    return false;
  }
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
