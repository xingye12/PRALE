// Execute the shipped view with a minimal DOM and an HTTP-contract fake.
import assert from "node:assert/strict";
import { createChatView } from "../../src/agent_harness/web/chat.js";

class Element {
  constructor(tag = "text") { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.handlers = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
}
globalThis.Node = Element;
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => Object.assign(new Element(), { textContent: text }),
};
function all(node) { return [node, ...node.children.flatMap(all)]; }
function button(view, label) { return all(view.element).find((node) => node.tag === "button" && node.textContent === label); }
const original = { approval_id: "approval-1", tool_name: "bash", lane: "__subagent__/child", operation_id: "op", reason: "shell execution", cwd: "/worktree", arguments: { command: "echo <script>" }, source: { run_id: "child" } };
let pending = [original], grants = [], requests = [], release;
const app = {
  scope: () => ({ session: "s", lane: "main" }), live: new Map(), report: (error) => { throw error; }, navigate() {},
  api: { async request(path, options = {}) {
    if (options.method === "POST") {
      requests.push({ path, body: options.body });
      if (path.endsWith("/decision")) {
        await new Promise((resolve) => { release = resolve; });
        if (options.body.decision === "allow_session") grants = [{ ...original, grant_id: original.approval_id, subject: original.lane, revoked: false }];
        pending = [];
      } else if (path.endsWith("/revoke")) grants = [];
      return {};
    }
    if (path.endsWith("/approval-grants")) return { items: grants };
    if (path.endsWith("/approvals")) return { items: pending };
    return { items: [], next_cursor: null };
  } },
};
const view = createChatView(app);
await view.refresh();
assert.ok(all(view.element).some((node) => node.textContent.includes("/worktree")));
assert.ok(all(view.element).some((node) => node.textContent.includes("echo <script>")));
assert.ok(button(view, "允许本次"));
assert.ok(button(view, "拒绝"));
const approve = button(view, "允许本会话相同操作");
const first = approve.handlers.click();
assert.equal(button(view, "允许本次").attrs.disabled, "");
await approve.handlers.click();
assert.equal(requests.length, 1);
release();
await first;
assert.equal(requests[0].body.decision, "allow_session");
assert.equal(button(view, "允许本次"), undefined);
await button(view, "撤销授权").handlers.click();
assert.ok(requests[1].path.endsWith("/approval-grants/approval-1/revoke"));
pending = [{ ...original, approval_id: "approval-2" }];
const refreshed = createChatView(app); // A new page re-queries durable pending requests.
await refreshed.refresh();
const rejected = button(refreshed, "拒绝").handlers.click();
release();
await rejected;
assert.equal(requests[2].body.decision, "reject");
console.log("approval view interactions passed");
