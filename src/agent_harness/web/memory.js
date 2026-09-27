// 记忆视图：L0 / L1 / L2 / L3 四个层级 + 晋升任务与审计。
//
// 全部只读。scope 由服务端从部署配置派生（ADR-WEB-003），页面只提交 allow-list
// 查找键（archive_id、status、cursor）。

import { append, badge, card, clear, empty, h, kv, notice, sectionTitle, table, tabs, tag } from "./dom.js";
import { DASH, clock, count, errorText, jsonText, listOrDash, shortId } from "./format.js";

const TABS = [
  { id: "l0", label: "L0 轨迹归档" },
  { id: "l1", label: "L1 原子记忆" },
  { id: "l2", label: "L2 工作场景" },
  { id: "l3", label: "L3 全局 doctrine" },
  { id: "jobs", label: "晋升任务" },
  { id: "audit", label: "审计" },
];

const L1_STATUSES = ["", "active", "superseded", "rejected"];
const L2_STATUSES = ["", "current", "dormant"];

export function createMemoryView(app) {
  const element = h("div");
  let tab = "l0";
  let items = [];
  let nextCursor = null;
  let detail = null;
  let selected = null;
  let statusFilter = "";
  let loading = false;
  let error = null;

  function head() {
    const project = app.state.project;
    return [
      h("h1", { class: "view-title" }, "记忆", h("small", { text: project ? `repository_id: ${project.repository_id}` : "" })),
      h("p", {
        class: "view-sub",
        text: "只读浏览：L0--L3 的内容、版本与来源引用均按存储中的原样展示，不提供修改、晋升或 GC 操作。",
      }),
    ];
  }

  function statusSelector(options, onChange) {
    const select = h("select", {
      onchange: (event) => onChange(event.target.value),
    });
    for (const value of options) {
      const label = value === "" ? "全部状态" : value;
      select.append(h("option", { value, text: label, selected: value === statusFilter }));
    }
    return h("label", { class: "field" }, h("span", { text: "status" }), select);
  }

  function archiveCard(summary) {
    return card(
      [
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "mono", text: shortId(summary.archive_id, 14), title: summary.archive_id }),
          h("span", { class: "spacer" }),
          h("span", { class: "meta", text: clock(summary.created_at) }),
        ),
        h("div", { class: "meta", text: `${summary.session_id} / ${summary.lane}` }),
        h("div", { class: "meta", text: `items ${summary.item_count} · ${summary.operation_kind} · 格式 v${summary.trace_format_version}` }),
        summary.parent_archive_id
          ? h("div", { class: "meta", text: `parent ${shortId(summary.parent_archive_id, 12)}` })
          : h("div", { class: "meta", text: "无 parent archive" }),
      ],
      { selected: selected === summary.archive_id, onClick: () => select(summary.archive_id) },
    );
  }

  function archiveDetail(archive) {
    const nodes = [
      h(
        "h2",
        { class: "view-title" },
        "L0 归档",
        h("span", { class: "mono", text: shortId(archive.archive_id, 16), title: archive.archive_id }),
      ),
      kv([
        ["session", h("span", { class: "mono", text: archive.session_id })],
        ["lane", archive.lane],
        ["operation", h("span", { class: "mono", text: archive.operation_id })],
        ["kind", archive.operation_kind],
        ["创建", clock(archive.created_at)],
        ["格式版本", archive.trace_format_version],
        ["content_hash", h("span", { class: "mono", text: archive.content_hash })],
        ["source_entry_hash", h("span", { class: "mono", text: archive.source_entry_hash })],
        ["base_tip", archive.base_tip_id ? h("span", { class: "mono", text: shortId(archive.base_tip_id, 12) }) : DASH],
        ["tip", archive.tip_id ? h("span", { class: "mono", text: shortId(archive.tip_id, 12) }) : DASH],
        ["parent archive", archive.parent_archive_id ? h("span", { class: "mono", text: archive.parent_archive_id }) : DASH],
        ["parent_gap", archive.parent_gap ? badge("存在断层", "warn", "parent 归档缺失：祖先内容无法完整回溯") : "无"],
        ["祖先 items", count(archive.ancestor_item_ids.length)],
      ]),
      sectionTitle(`items（${archive.items.length}）`),
    ];
    for (const item of archive.items) {
      nodes.push(
        card(
          [
            h(
              "div",
              { class: "card-head" },
              badge(item.type, "pending"),
              item.role ? tag(item.role) : null,
              h("span", { class: "spacer" }),
              h("span", { class: "meta", text: `seq ${item.source_seq}` }),
              h("span", { class: "meta", text: clock(item.timestamp) }),
            ),
            item.content ? h("pre", { text: item.content }) : h("pre", { class: "block", text: jsonText(item.payload) }),
            item.redacted_paths.length
              ? h("p", { class: "meta", text: `已脱敏字段：${listOrDash(item.redacted_paths)}` })
              : h("p", { class: "meta", text: "无脱敏字段" }),
            h("p", { class: "meta", text: `source_entry ${item.source_entry_id} · store_seq ${item.store_seq}` }),
          ],
        ),
      );
    }
    if (archive.ancestor_items.length) {
      nodes.push(sectionTitle(`继承的祖先 items（${archive.ancestor_items.length}）`));
      nodes.push(
        h("p", { class: "meta", text: "这些条目来自 parent 归档链，不是本次 operation 产生的。" }),
      );
      for (const item of archive.ancestor_items) {
        nodes.push(card([h("div", { class: "meta", text: `#${item.source_seq} ${item.role || item.type}` }), h("pre", { text: item.content || jsonText(item.payload) })]));
      }
    }
    return h("div", {}, nodes);
  }

  function l1List() {
    return items.map((memory) =>
      card(
        [
          h(
            "div",
            { class: "card-head" },
            badge(memory.status, memory.status === "active" ? "ok" : memory.status === "superseded" ? "warn" : "bad"),
            tag(memory.type),
            h("span", { class: "meta", text: `v${memory.version}` }),
            h("span", { class: "spacer" }),
            h("span", { class: "meta", text: clock(memory.updated_at) }),
          ),
          h("pre", { class: "clamp-2", text: memory.content }),
          kv([
            ["scene_key", memory.scene_key || DASH],
            ["priority", count(memory.priority)],
            ["confidence", memory.confidence === null || memory.confidence === undefined ? DASH : String(memory.confidence)],
            ["supersedes", listOrDash(memory.supersedes_ids)],
            ["来源记录", listOrDash(memory.source_record_ids.map((id) => shortId(id, 10)))],
            ["content_hash", h("span", { class: "mono", text: shortId(memory.content_hash, 16) })],
            ["最后确认", clock(memory.last_confirmed_at)],
          ]),
          memory.background ? h("details", {}, h("summary", { text: "background" }), h("pre", { class: "block", text: memory.background })) : null,
          Object.keys(memory.metadata || {}).length
            ? h("details", {}, h("summary", { text: "metadata" }), h("pre", { class: "block", text: jsonText(memory.metadata) }))
            : null,
        ],
      ),
    );
  }

  function l2List() {
    return items.map((scene) =>
      card(
        [
          h(
            "div",
            { class: "card-head" },
            badge(scene.status, scene.status === "current" ? "ok" : "warn"),
            h("span", { class: "meta", text: scene.scenario_key || DASH }),
            h("span", { class: "meta", text: `v${scene.version}` }),
            scene.persona_update_request ? badge("请求 persona 更新", "warn") : null,
            h("span", { class: "spacer" }),
            h("span", { class: "meta", text: clock(scene.updated_at) }),
          ),
          scene.summary ? h("p", { text: scene.summary }) : null,
          h("pre", { text: scene.content }),
          kv([
            ["heat", scene.heat === null || scene.heat === undefined ? DASH : String(scene.heat)],
            ["created", clock(scene.created_at)],
            ["scene_id", h("span", { class: "mono", text: shortId(scene.scene_id, 16), title: scene.scene_id })],
            ["content_hash", h("span", { class: "mono", text: shortId(scene.content_hash, 16) })],
          ]),
        ],
      ),
    );
  }

  function l3Body() {
    if (!detail) return empty("该仓库还没有 doctrine", "L3 是全局唯一的一份操作准则；未形成时这里保持为空。");
    return [
      kv([
        ["doctrine_id", h("span", { class: "mono", text: detail.doctrine_id })],
        ["version", `v${detail.version}`],
        ["更新", clock(detail.updated_at)],
        ["创建", clock(detail.created_at)],
        ["content_hash", h("span", { class: "mono", text: detail.content_hash })],
      ]),
      h("pre", { class: "block", text: detail.content }),
    ];
  }

  function jobsTable() {
    return table(
      [
        { label: "job", render: (job) => shortId(job.job_id, 14) },
        { label: "stage", render: (job) => tag(job.stage) },
        { label: "status", render: (job) => badge(job.status, job.status === "dead_letter" ? "bad" : job.status === "completed" ? "ok" : "warn") },
        { label: "attempt", render: (job) => job.attempt },
        { label: "not_before", render: (job) => clock(job.not_before) },
        { label: "watermark", render: (job) => job.input_high_watermark },
        { label: "lease", render: (job) => (job.lease_id ? `${shortId(job.lease_id, 8)} → ${clock(job.lease_until)}` : DASH) },
        { label: "error", render: (job) => job.error_class || DASH },
        { label: "output_hash", render: (job) => (job.output_hash ? shortId(job.output_hash, 12) : DASH) },
        { label: "更新", render: (job) => clock(job.updated_at) },
      ],
      items,
    );
  }

  function auditTable() {
    return table(
      [
        { label: "id", render: (record) => record.audit_id },
        { label: "时间", render: (record) => clock(record.created_at) },
        { label: "event", render: (record) => badge(record.event, "pending") },
        { label: "data", render: (record) => h("pre", { class: "block", text: jsonText(record.data) }) },
      ],
      items,
    );
  }

  function body() {
    if (loading) return [h("p", { class: "meta", text: "读取中…" })];
    if (tab === "l0") {
      if (selected && detail) return [h("div", { class: "split" }, h("div", { class: "list" }, listColumn()), h("div", {}, archiveDetail(detail)))];
      return [listColumn()];
    }
    if (tab === "l1") return items.length ? l1List() : [empty("没有 L1 原子记忆", "晋升管道尚未从 L0 归档中提炼出条目，或当前状态过滤把它们全部排除。")];
    if (tab === "l2") return items.length ? l2List() : [empty("没有 L2 工作场景", "工作场景由 L1 聚合产生；未形成时这里保持为空。")];
    if (tab === "l3") return l3Body();
    if (tab === "jobs") return items.length ? [jobsTable()] : [empty("没有晋升任务", "任务由 durable 水位线驱动；没有待处理输入时队列为空。")];
    return items.length ? [auditTable()] : [empty("没有审计记录", "该 store 还没有写入审计事件。")];
  }

  function listColumn() {
    const nodes = [];
    nodes.push(
      h(
        "div",
        { class: "card-head" },
        tab === "l0" ? h("span", { class: "meta", text: `${items.length} 个归档` }) : null,
        h("span", { class: "spacer" }),
        tab === "l0" ? null : statusSelector(tab === "l1" ? L1_STATUSES : L2_STATUSES, (value) => {
          statusFilter = value;
          refresh();
        }),
      ),
    );
    if (!items.length) nodes.push(empty("没有记录", "该层级当前没有可浏览的条目。"));
    if (tab === "l0") nodes.push(...items.map(archiveCard));
    else if (tab === "l1") nodes.push(...l1List());
    else if (tab === "l2") nodes.push(...l2List());
    if (nextCursor) {
      nodes.push(
        h("div", { class: "pager" }, h("button", { type: "button", text: "加载更多", onClick: () => loadMore() })),
      );
    }
    return nodes;
  }

  function select(archiveId) {
    selected = archiveId;
    loadDetail().then(render).catch((failure) => {
      error = failure;
      render();
    });
  }

  async function loadDetail() {
    if (!selected) {
      detail = null;
      return;
    }
    detail = await app.api.request(`/memory/l0/${encodeURIComponent(selected)}`);
  }

  const PATHS = {
    l0: "/memory/l0",
    l1: "/memory/l1",
    l2: "/memory/l2",
    l3: "/memory/l3",
    jobs: "/memory/jobs",
    audit: "/memory/audit",
  };

  async function loadMore() {
    if (!nextCursor) return;
    await fetchPage(nextCursor, true);
    render();
  }

  async function fetchPage(cursor, appendItems) {
    const path = PATHS[tab];
    if (tab === "l3") {
      // L3 is a single global doctrine, not a page: the route wraps it so that
      // "no doctrine yet" and "doctrine" are different responses.
      const payload = await app.api.request(path);
      detail = payload.doctrine;
      items = [];
      nextCursor = null;
      return;
    }
    const query = { limit: 25, cursor };
    if (tab === "l1" || tab === "l2" || tab === "jobs") query.status = statusFilter;
    const page = await app.api.request(path, { query });
    items = appendItems ? [...items, ...page.items] : page.items;
    nextCursor = page.next_cursor;
  }

  async function refresh() {
    loading = true;
    error = null;
    render();
    try {
      await fetchPage(null, false);
      if (tab === "l0" && selected) await loadDetail();
    } catch (failure) {
      error = failure;
      items = [];
      detail = null;
    }
    loading = false;
    render();
  }

  function render() {
    clear(element);
    append(element, head());
    append(
      element,
      tabs(TABS, tab, (next) => {
        tab = next;
        selected = null;
        detail = null;
        nextCursor = null;
        items = [];
        app.navigate({ view: "memory", params: { tab } });
      }),
    );
    if (error) {
      const unavailable = error.status === 503;
      append(
        element,
        notice(
          unavailable
            ? `该部署未配置记忆 store：${errorText(error)}`
            : errorText(error),
          error.status === 401 || unavailable ? "bad" : "warn",
        ),
      );
    }
    append(element, body());
  }

  return {
    element,
    render,
    params(params) {
      // Same rule as the skill view: an L0 archive id is not meaningful in
      // another layer, so a tab change through the URL clears the selection.
      if (params.tab && params.tab !== tab && TABS.some((item) => item.id === params.tab)) {
        tab = params.tab;
        selected = null;
        detail = null;
        items = [];
        nextCursor = null;
      }
    },
    refresh,
    onEvent() {},
  };
}
