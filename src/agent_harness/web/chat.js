// 对话视图：durable turn 历史 + 显式提交、中止、恢复。
//
// 实时性来自事件流，但内容永远来自 durable 读取：事件只触发重新读取，或驱动
// 一个明确标注为"流式接收中（未落盘）"的临时气泡。刷新页面后看到的历史与流中
// 看到的一致，因为两者来自同一次查询。

import { append, badge, card, clear, empty, h, notice, tag } from "./dom.js";
import { clock, count, duration, errorText, operationStatus, shortId } from "./format.js";

const TURN_LIMIT = 20;

export function createChatView(app) {
  const element = h("div");
  let turns = [];
  let details = new Map();
  let nextCursor = null;
  let busy = false;
  let error = null;

  element.addEventListener("click", (event) => {
    const jump = event.target.closest("[data-trace-turn]");
    if (jump) app.navigate({ view: "trace", params: { turn: jump.dataset.traceTurn } });
  });

  function head() {
    const scope = app.scope();
    return [
      h("h1", { class: "view-title" }, "对话", h("small", { text: scope ? `${scope.session} / ${scope.lane}` : "未选择 session" })),
      h("p", {
        class: "view-sub",
        text: "每条 turn 按 durable 记录渲染：状态为 null 表示该 operation 尚未结算，既不是成功也不是失败。",
      }),
    ];
  }

  function turnHead(summary) {
    const status = operationStatus(summary.status);
    const nodes = [
      h("span", { class: "mono", text: shortId(summary.operation_id, 10), title: summary.operation_id }),
      badge(status.label, status.tone, status.detail),
      tag(summary.kind),
      h("span", { class: "meta", text: clock(summary.started_at) }),
    ];
    if (app.live.has(summary.operation_id)) {
      nodes.push(badge("本次连接观察到活动", "pending", "本进程在当前事件流中看到过该 operation 的事件"));
    }
    nodes.push(
      h("span", { class: "meta", text: `耗时 ${duration(summary.duration_ms)}` }),
      h("span", {
        class: "meta",
        title: "input / output / total；provider 未给出的字段显示 —",
        text: `token ${count(summary.input_tokens)} / ${count(summary.output_tokens)} / ${count(summary.total_tokens)}`,
      }),
      h("span", {
        class: "meta",
        text: `效应 ${summary.span_count}${summary.pending_spans ? `（${summary.pending_spans} 未结算）` : ""}`,
      }),
      h("span", { class: "spacer" }),
      h("button", {
        type: "button",
        class: "ghost",
        text: "查看轨迹",
        dataset: { traceTurn: summary.operation_id },
      }),
    );
    if (summary.error_code) nodes.splice(4, 0, badge(summary.error_code, "bad", summary.error_message));
    return nodes;
  }

  function renderTurn(summary) {
    const detail = details.get(summary.operation_id);
    const body = [];
    if (detail) {
      for (const entry of detail.entries) body.push(messageNode(entry));
      if (detail.unattributed_usage.length) {
        body.push(
          h("p", {
            class: "meta",
            text: `另有 ${detail.unattributed_usage.length} 条 usage 只能归属到 entry，无法证明属于本 turn，已在轨迹页单列。`,
          }),
        );
      }
    } else {
      body.push(h("p", { class: "meta", text: "该 operation 尚未结算：暂无可读的时间线。" }));
    }
    const live = app.live.get(summary.operation_id);
    if (live && live.text) {
      body.push(
        h(
          "div",
          { class: "message", dataset: { role: "assistant" } },
          h(
            "div",
            { class: "message-head" },
            badge("assistant", "ok"),
            h("span", { text: "流式接收中（尚未落盘）" }),
          ),
          h("pre", { class: "live", text: live.text }),
        ),
      );
    }
    return card(body, { head: turnHead(summary) });
  }

  function messageNode(entry) {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    const role = typeof payload.role === "string" ? payload.role : entry.type;
    const tone = role === "user" ? "ok" : role === "tool" ? "warn" : "pending";
    const nodes = [
      h(
        "div",
        { class: "message-head" },
        badge(role, tone),
        h("span", { text: `#${entry.seq}` }),
        h("span", { text: clock(entry.timestamp) }),
        entry.custom_type ? h("span", { text: entry.custom_type }) : null,
      ),
    ];
    const content = typeof payload.content === "string" ? payload.content : "";
    if (content) nodes.push(h("pre", { text: content }));
    if (Array.isArray(payload.tool_calls)) {
      for (const call of payload.tool_calls) {
        nodes.push(
          h(
            "details",
            {},
            h("summary", { text: `tool_call ${call.name || "?"} · ${shortId(call.id, 10)}` }),
            h("pre", { class: "block", text: formatValue(call.arguments) }),
          ),
        );
      }
    }
    if (payload.is_error) nodes.push(badge("tool 返回错误", "bad"));
    if (typeof payload.error === "string") nodes.push(h("p", { class: "meta", text: payload.error }));
    if (payload.terminate) nodes.push(badge("terminate", "warn"));
    if (!content && !Array.isArray(payload.tool_calls)) {
      nodes.push(
        h("details", {}, h("summary", { text: "payload" }), h("pre", { class: "block", text: formatValue(payload) })),
      );
    }
    return h("div", { class: "message", dataset: { role } }, nodes);
  }

  function formatValue(value) {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value ?? null, null, 2);
    } catch {
      return String(value);
    }
  }

  function composer() {
    const scope = app.scope();
    const textarea = h("textarea", {
      placeholder: "输入 prompt：Enter 发送，Shift+Enter 换行",
      disabled: !scope || busy,
      onkeydown: (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          send(textarea);
        }
      },
    });
    const live = [...app.live.keys()];
    return h(
      "div",
      { class: "composer" },
      textarea,
      h(
        "div",
        { class: "composer-actions" },
        h("button", { type: "button", text: "发送", disabled: !scope || busy, onClick: () => send(textarea) }),
        h("span", { class: "spacer" }),
        h("button", {
          type: "button",
          class: "ghost",
          text: "中止当前 operation",
          title: "只有显式 abort 会取消工作；关闭页面只会结束事件订阅",
          disabled: !scope || !live.length,
          onClick: () => abort(),
        }),
        h("button", {
          type: "button",
          class: "ghost",
          text: "recover",
          title: "收束没有存活进程的 operation；本进程正在 drive 该 lane 时会返回 409",
          disabled: !scope,
          onClick: () => recover(),
        }),
      ),
    );
  }

  async function send(textarea) {
    const prompt = textarea.value.trim();
    const target = app.scope();
    if (!prompt || !target || busy) return;
    busy = true;
    textarea.value = "";
    try {
      await app.api.request(`/sessions/${encodeURIComponent(target.session)}/lanes/${encodeURIComponent(target.lane)}/turns`, {
        method: "POST",
        body: { prompt },
      });
      app.toast("turn 已受理，正在后台运行。");
      await load({ reset: true });
    } catch (failure) {
      app.report(failure);
      textarea.value = prompt;
    } finally {
      busy = false;
      render();
    }
  }

  async function abort() {
    const target = app.scope();
    if (!target) return;
    try {
      const result = await app.api.request(
        `/sessions/${encodeURIComponent(target.session)}/lanes/${encodeURIComponent(target.lane)}/abort`,
        { method: "POST" },
      );
      app.toast(`已请求中止 ${shortId(result.operation_id, 10)}（本次新请求：${result.newly_requested}）。`);
      await load({ reset: true });
    } catch (failure) {
      app.report(failure);
    }
  }

  async function recover() {
    const target = app.scope();
    if (!target) return;
    try {
      const payload = await app.api.request(
        `/sessions/${encodeURIComponent(target.session)}/lanes/${encodeURIComponent(target.lane)}/recover`,
        { method: "POST" },
      );
      const result = payload.result;
      app.toast(result ? `recover 将该 operation 收束为 ${result.status}。` : "该 lane 没有需要接管的 operation。");
      await load({ reset: true });
    } catch (failure) {
      app.report(failure);
    }
  }

  async function load({ reset = false } = {}) {
    const target = app.scope();
    if (!target) {
      turns = [];
      details = new Map();
      error = null;
      render();
      return;
    }
    const limit = reset ? TURN_LIMIT : turns.length + TURN_LIMIT;
    try {
      const page = await app.api.request(`/sessions/${encodeURIComponent(target.session)}/turns`, {
        query: { lane: target.lane, limit },
      });
      turns = page.items;
      nextCursor = page.next_cursor;
      error = null;
      const wanted = turns.filter((turn) => !details.has(turn.operation_id) || turn.status === null);
      const fetched = await Promise.all(
        wanted.map((turn) =>
          app.api
            .request(`/sessions/${encodeURIComponent(target.session)}/turns/${encodeURIComponent(turn.operation_id)}`)
            .catch(() => null),
        ),
      );
      fetched.forEach((detail, index) => {
        if (detail) details.set(wanted[index].operation_id, detail);
      });
      dropSettledLiveBubbles();
    } catch (failure) {
      error = failure;
    }
    render();
  }

  /** A live bubble is a claim about right now; durable settlement retires it. */
  function dropSettledLiveBubbles() {
    const settled = new Set(turns.filter((turn) => turn.status !== null).map((turn) => turn.operation_id));
    for (const operationId of [...app.live.keys()]) {
      if (settled.has(operationId)) app.live.delete(operationId);
    }
  }

  function render() {
    clear(element);
    append(element, head());
    if (error) append(element, notice(errorText(error), error.status === 503 || error.status === 401 ? "bad" : "warn"));
    const scope = app.scope();
    if (!scope) {
      append(element, empty("尚未选择 session", "在顶栏新建或选择一个 session，再选择 lane 开始对话。"));
      return;
    }
    if (!turns.length && !error) {
      append(element, empty("该 lane 还没有 turn", "提交第一条 prompt，它的 durable 记录会出现在这里。"));
    }
    const list = h("div");
    for (const turn of [...turns].reverse()) list.append(renderTurn(turn));
    append(element, list);
    if (nextCursor) {
      append(
        element,
        h("div", { class: "pager" }, h("button", { type: "button", text: "加载更早的 turn", onClick: () => load() })),
      );
    }
    append(element, composer());
  }

  return {
    element,
    render,
    refresh: () => load({ reset: true }),
    onEvent(name, data) {
      if (name === "message_start" && data.operation_id) {
        if (!app.live.has(data.operation_id)) app.live.set(data.operation_id, { text: "" });
        render();
      } else if (name === "message_update" && data.operation_id) {
        const live = app.live.get(data.operation_id) || { text: "" };
        live.text += typeof data.data?.content === "string" ? data.data.content : "";
        app.live.set(data.operation_id, live);
        render();
      }
    },
  };
}
