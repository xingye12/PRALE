// 轨迹视图：turn 列表 + 单个 turn 的完整时间线。
//
// 时间线把 entry 与 effect span 按记录的 wall-clock 归并展示；call 耗时只读
// `duration_ms`（domain 的判定：pending/unknown 没有可证明的耗时），绝不拿
// `ended_at - started_at` 现算。

import { append, badge, card, clear, empty, h, kv, notice, sectionTitle, table, tag } from "./dom.js";
import { DASH, NOT_RECORDED, RESULT_UNKNOWN, clock, count, duration, errorText, jsonText, operationStatus, shortId, spanOutcome } from "./format.js";

const TURN_LIMIT = 25;

export function createTraceView(app) {
  const element = h("div");
  let turns = [];
  let nextCursor = null;
  let detail = null;
  let selected = null;
  let error = null;

  function head() {
    const scope = app.scope();
    return [
      h("h1", { class: "view-title" }, "轨迹", h("small", { text: scope ? `${scope.session} / ${scope.lane}` : "未选择 session" })),
      h("p", {
        class: "view-sub",
        text: "turn、effect span 与 usage 全部来自 session 数据库；未结算与结果未知都按原样标注。",
      }),
    ];
  }

  function turnRow(summary) {
    const status = operationStatus(summary.status);
    return card(
      [
        h(
          "div",
          { class: "card-head" },
          tag(summary.kind),
          badge(status.label, status.tone, status.detail),
          h("span", { class: "spacer" }),
          h("span", { class: "meta", text: duration(summary.duration_ms) }),
        ),
        h(
          "div",
          { class: "meta" },
          `${clock(summary.started_at)} · 效应 ${summary.span_count}${
            summary.pending_spans ? `（${summary.pending_spans} 未结算）` : ""
          } · token ${count(summary.total_tokens)}`,
        ),
        h("div", { class: "mono", text: shortId(summary.operation_id, 14), title: summary.operation_id }),
      ],
      { selected: selected === summary.operation_id, onClick: () => app.navigate({ view: "trace", params: { turn: summary.operation_id } }) },
    );
  }

  function timeline(detail) {
    const events = [];
    for (const entry of detail.entries) {
      events.push({ at: entry.timestamp, order: 0, seq: entry.seq, node: entryNode(entry) });
    }
    for (const span of detail.spans) {
      events.push({ at: span.started_at, order: 1, seq: 0, node: spanNode(span, detail) });
    }
    events.sort((left, right) => left.at - right.at || left.order - right.order || left.seq - right.seq);
    return events.map((event) => event.node);
  }

  function entryNode(entry) {
    const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : {};
    const role = typeof payload.role === "string" ? payload.role : entry.type;
    const nodes = [
      h(
        "div",
        { class: "message-head" },
        badge(entry.type, "pending"),
        h("span", { text: role }),
        h("span", { text: `#${entry.seq}` }),
        h("span", { text: clock(entry.timestamp) }),
        h("span", { class: "mono", text: shortId(entry.id, 10), title: entry.id }),
        entry.parent_id ? h("span", { class: "mono", text: `← ${shortId(entry.parent_id, 8)}` }) : null,
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
            h("pre", { class: "block", text: jsonText(call.arguments) }),
          ),
        );
      }
    }
    if (typeof payload.content_checkpoint === "string" && payload.content_checkpoint) {
      nodes.push(h("p", { class: "meta", text: `checkpoint：${payload.content_checkpoint}` }));
    }
    if (payload.is_error) nodes.push(badge("tool 返回错误", "bad"));
    if (typeof payload.error === "string") nodes.push(h("p", { class: "meta", text: payload.error }));
    if (typeof payload.stop_reason === "string" && payload.stop_reason) {
      nodes.push(h("p", { class: "meta", text: `stop_reason: ${payload.stop_reason}` }));
    }
    if (!content && !Array.isArray(payload.tool_calls) && entry.type !== "custom") {
      nodes.push(h("details", {}, h("summary", { text: "payload" }), h("pre", { class: "block", text: jsonText(payload) })));
    } else if (entry.type === "custom") {
      nodes.push(h("pre", { class: "block", text: jsonText(payload) }));
    }
    const roleClass = ["user", "assistant", "tool", "system"].includes(role) ? role : "system";
    return h("div", { class: "message", dataset: { role: roleClass } }, nodes);
  }

  function spanNode(span, detail) {
    const outcome = spanOutcome(span.outcome);
    const usage = detail.usage.filter((record) => record.span_id === span.span_id);
    const nodes = [
      h(
        "div",
        { class: "message-head" },
        badge(span.kind === "llm" ? "LLM 调用" : "tool 调用", span.kind === "llm" ? "ok" : "warn"),
        badge(outcome.label, outcome.tone),
        h("span", { text: clock(span.started_at) }),
        h("span", { class: "mono", text: `attempt ${span.attempt}` }),
        h("span", { class: "meta", text: `耗时 ${duration(span.duration_ms)}` }),
        span.error_class ? badge(span.error_class, "bad") : null,
      ),
      kv([
        ["span", h("span", { class: "mono", text: span.span_id })],
        ["call", h("span", { class: "mono", text: span.call_id })],
        ["lane", span.lane],
        ["结束", clock(span.ended_at)],
      ]),
    ];
    if (!span.ended_at && span.outcome === "pending") {
      nodes.push(h("p", { class: "meta", text: "该效应已发出但未结算：没有可证明的结束时间，因此不显示耗时。" }));
    }
    if (span.outcome === "unknown") {
      nodes.push(
        h("p", {
          class: "meta",
          text: `${RESULT_UNKNOWN}：${
            span.ended_at ? "ended_at 记录的是收束时刻，不是调用耗时。" : "该效应没有可证明的结束时间。"
          }`,
        }),
      );
    }
    for (const record of usage) nodes.push(usageNode(record));
    return h("div", { class: "message", dataset: { role: span.kind === "llm" ? "assistant" : "tool" } }, nodes);
  }

  function usageNode(record) {
    return h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "card-body" },
        kv([
          ["usage", h("span", { class: "mono", text: record.id })],
          ["input", count(record.input_tokens)],
          ["output", count(record.output_tokens)],
          ["total", count(record.total_tokens)],
          ["entry", record.entry_id ? h("span", { class: "mono", text: shortId(record.entry_id, 12) }) : DASH],
          ["span", record.span_id ? h("span", { class: "mono", text: shortId(record.span_id, 12) }) : DASH],
        ]),
      ),
    );
  }

  function detailPane() {
    if (!selected) return empty("未选择 turn", "在左侧选择一个 turn，查看它的 entry、效应与用量。");
    if (!detail) return h("p", { class: "meta", text: "读取中…" });
    const summary = detail.summary;
    const status = operationStatus(summary.status);
    const nodes = [
      h(
        "h2",
        { class: "view-title" },
        h("span", { class: "mono", text: shortId(summary.operation_id, 14), title: summary.operation_id }),
        badge(status.label, status.tone, status.detail),
        tag(summary.kind),
      ),
      kv([
        ["session", h("span", { class: "mono", text: summary.session_id })],
        ["lane", summary.lane],
        ["开始", clock(summary.started_at)],
        ["结束", clock(summary.ended_at)],
        ["总耗时", `${duration(summary.duration_ms)}（turn 级，含重试与全部子调用）`],
        ["input tokens", count(summary.input_tokens)],
        ["output tokens", count(summary.output_tokens)],
        ["total tokens", count(summary.total_tokens)],
        ["效应", `${summary.span_count}（${summary.pending_spans} 未结算）`],
        ["error_code", summary.error_code ? h("span", { class: "mono", text: summary.error_code }) : DASH],
        ["error_message", summary.error_message || DASH],
      ]),
    ];
    const request = detail.request && typeof detail.request === "object" ? detail.request : {};
    nodes.push(
      h("details", {}, h("summary", { text: "durable request（提交时的输入）" }), h("pre", { class: "block", text: jsonText(request) })),
    );
    if (detail.result) {
      nodes.push(
        sectionTitle("结算结果"),
        kv([
          ["status", detail.result.status],
          ["from_tip", detail.result.from_tip_id ? h("span", { class: "mono", text: shortId(detail.result.from_tip_id, 12) }) : DASH],
          ["tip", detail.result.tip_id ? h("span", { class: "mono", text: shortId(detail.result.tip_id, 12) }) : DASH],
          ["ended_at", clock(detail.result.ended_at)],
        ]),
      );
    } else {
      nodes.push(sectionTitle("结算结果"), h("p", { class: "meta", text: `尚未结算：${DASH}（不是成功，也不是失败）` }));
    }

    nodes.push(sectionTitle("效应与用量"));
    nodes.push(
      table(
        [
          { label: "kind", render: (span) => span.kind },
          { label: "span", render: (span) => span.span_id },
          { label: "call", render: (span) => span.call_id },
          { label: "attempt", render: (span) => span.attempt },
          {
            label: "outcome",
            render: (span) => badge(spanOutcome(span.outcome).label, spanOutcome(span.outcome).tone),
          },
          { label: "耗时", render: (span) => duration(span.duration_ms) },
          { label: "error_class", render: (span) => span.error_class || DASH },
          { label: "input", render: (span) => usageCell(detail, span.span_id, "input_tokens") },
          { label: "output", render: (span) => usageCell(detail, span.span_id, "output_tokens") },
          { label: "total", render: (span) => usageCell(detail, span.span_id, "total_tokens") },
        ],
        detail.spans,
      ),
    );
    if (!detail.spans.length) {
      nodes.push(
        h("p", {
          class: "meta",
          text: `${NOT_RECORDED}：该 session 在记录 effect span 之前写入，call 级耗时与归属都不可推断。`,
        }),
      );
    }

    nodes.push(sectionTitle("时间线（entry 与效应按记录时间归并）"));
    const timelineNodes = timeline(detail);
    if (timelineNodes.length) nodes.push(h("div", {}, timelineNodes));
    else nodes.push(h("p", { class: "meta", text: "没有时间线记录。" }));

    if (detail.unattributed_usage.length) {
      nodes.push(sectionTitle("无法归属到本 turn 的 usage"));
      nodes.push(
        h("p", {
          class: "meta",
          text: "这些记录只绑定到 entry：把她们计入任何一侧都会同时误报本 turn 与相邻 turn。",
        }),
      );
      nodes.push(
        table(
          [
            { label: "usage", render: (record) => record.id },
            { label: "entry", render: (record) => record.entry_id || DASH },
            { label: "input", render: (record) => count(record.input_tokens) },
            { label: "output", render: (record) => count(record.output_tokens) },
            { label: "total", render: (record) => count(record.total_tokens) },
          ],
          detail.unattributed_usage,
        ),
      );
    }
    return h("div", {}, nodes);
  }

  /** A call's tokens: one record, or the sum of several, labelled as such. */
  function usageCell(detail, spanId, field) {
    const records = detail.usage.filter((record) => record.span_id === spanId);
    if (!records.length) return DASH;
    if (records.length === 1) return count(records[0][field]);
    const values = records.map((record) => record[field]).filter((value) => value !== null && value !== undefined);
    if (values.length !== records.length) return DASH;
    return h("span", {
      title: `${records.length} 条 usage 记录之和`,
      text: String(values.reduce((total, value) => total + value, 0)),
    });
  }

  async function loadTurns() {
    const scope = app.scope();
    if (!scope) return;
    const page = await app.api.request(`/sessions/${encodeURIComponent(scope.session)}/turns`, {
      query: { lane: scope.lane, limit: TURN_LIMIT },
    });
    turns = page.items;
    nextCursor = page.next_cursor;
  }

  async function loadDetail() {
    const scope = app.scope();
    if (!scope || !selected) {
      detail = null;
      return;
    }
    detail = await app.api.request(
      `/sessions/${encodeURIComponent(scope.session)}/turns/${encodeURIComponent(selected)}`,
    );
  }

  function paneLabel(records) {
    return h("p", { class: "meta", text: `${records.length} 条记录` });
  }

  function render() {
    clear(element);
    append(element, head());
    if (error) append(element, notice(errorText(error), error.status === 401 || error.status === 503 ? "bad" : "warn"));
    const scope = app.scope();
    if (!scope) {
      append(element, empty("尚未选择 session", "轨迹页依赖 session 与 lane 选择器。"));
      return;
    }
    append(
      element,
      h(
        "div",
        { class: "split" },
        h(
          "div",
          { class: "list" },
          sectionTitle("turn（最新在前）"),
          turns.length ? turns.map(turnRow) : empty("该 lane 还没有 turn", "提交一条 prompt 后即可在这里检查它的每一步。"),
          nextCursor
            ? h(
                "div",
                { class: "pager" },
                h("button", { type: "button", text: "加载更早的 turn", onClick: () => loadMore() }),
              )
            : null,
          paneLabel(turns),
        ),
        h("div", {}, detailPane()),
      ),
    );
  }

  async function loadMore() {
    const scope = app.scope();
    if (!scope || !nextCursor) return;
    const page = await app.api.request(`/sessions/${encodeURIComponent(scope.session)}/turns`, {
      query: { lane: scope.lane, limit: TURN_LIMIT, cursor: nextCursor },
    });
    turns = [...turns, ...page.items];
    nextCursor = page.next_cursor;
    render();
  }

  return {
    element,
    render,
    params: (params) => {
      selected = params.turn || selected;
    },
    async refresh() {
      try {
        await loadTurns();
        if (!selected && turns.length) selected = turns[0].operation_id;
        await loadDetail();
        error = null;
      } catch (failure) {
        error = failure;
      }
      render();
    },
    onEvent(name, data) {
      if (name === "tool_start" || name === "tool_end" || name === "message_end") {
        if (selected && data.operation_id === selected) loadDetail().then(render).catch(() => {});
      }
    },
  };
}
