// 技能视图：资产、版本历史、来源归档、提取任务与审计。
// 内容与版本只读；人工只能启用/停用已通过自动 Review 的 Skill。

import { append, badge, card, clear, empty, h, kv, notice, sectionTitle, table, tabs, tag } from "./dom.js";
import { DASH, bytes, clock, count, errorText, jsonText, listOrDash, shortId } from "./format.js";

const TABS = [
  { id: "skills", label: "技能资产" },
  { id: "archives", label: "来源归档" },
  { id: "jobs", label: "提取任务" },
  { id: "audit", label: "审计" },
];

const STATES = ["", "active", "disabled", "archived"];

export function createSkillsView(app) {
  const element = h("div");
  let tab = "skills";
  let items = [];
  let nextCursor = null;
  let detail = null;
  let versions = [];
  let selected = null;
  let stateFilter = "";
  let loading = false;
  let error = null;

  function head() {
    return [
      h("h1", { class: "view-title" }, "技能"),
      h("p", {
        class: "view-sub",
        text: "新提炼的 Skill 默认停用；在详情中启用后，Agent 才会发现和使用它。内容、版本与作用域仍为只读。",
      }),
    ];
  }

  function stateSelector() {
    const select = h("select", {
      onchange: (event) => {
        stateFilter = event.target.value;
        refresh();
      },
    });
    for (const value of STATES) {
      select.append(h("option", { value, text: value === "" ? "全部状态" : value, selected: value === stateFilter }));
    }
    return h("label", { class: "field" }, h("span", { text: "state" }), select);
  }

  function skillCard(skill) {
    return card(
      [
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "mono", text: shortId(skill.skill_id, 16), title: skill.skill_id }),
          badge(skill.state, skill.state === "active" ? "ok" : skill.state === "disabled" ? "warn" : "pending"),
          // A listing carries the version it is currently at, without the rest
          // of the asset: ``version`` here is the current one.
          h("span", { class: "meta", text: `v${skill.version}` }),
          h("span", { class: "spacer" }),
          h("span", { class: "meta", text: clock(skill.updated_at) }),
        ),
        h("p", { text: skill.name || skill.skill_id }),
        skill.description ? h("p", { class: "meta", text: skill.description }) : null,
        h("div", {}, skill.triggers.map((trigger) => tag(trigger))),
      ],
      { selected: selected === skill.skill_id, onClick: () => select(skill.skill_id) },
    );
  }

  function fileCard(file) {
    const isText = (file.mime_type || "").startsWith("text/") || file.mime_type === "application/json";
    const nodes = [
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "mono", text: file.path }),
        tag(file.mime_type),
        h("span", { class: "meta", text: bytes(byteLength(file.content)) }),
        h("span", { class: "spacer" }),
        h("a", { href: dataUrl(file), download: file.path.split("/").pop(), text: "下载" }),
      ),
    ];
    if (isText) {
      nodes.push(h("pre", { class: "block", text: decodeText(file.content) }));
    } else {
      nodes.push(h("p", { class: "meta", text: "二进制资源：不以内联文本展示，可通过下载查看。" }));
    }
    return card(nodes);
  }

  function versionCard(version) {
    const nodes = [
      h(
        "div",
        { class: "card-head" },
        h("span", { text: `v${version.version}` }),
        h("span", { class: "mono", text: shortId(version.content_hash, 16), title: version.content_hash }),
        h("span", { class: "spacer" }),
        h("span", { class: "meta", text: clock(version.created_at) }),
      ),
      h("details", { open: version.version === detail?.current_version }, h("summary", { text: "SKILL.md" }), h("pre", { class: "block", text: version.markdown })),
      h("details", {}, h("summary", { text: "manifest" }), h("pre", { class: "block", text: version.manifest })),
    ];
    for (const file of version.files) nodes.push(fileCard(file));
    if (!version.files.length) nodes.push(h("p", { class: "meta", text: "该版本没有资源文件。" }));
    return card(nodes);
  }

  function skillDetail(skill) {
    const enableToggle = skill.state === "archived"
      ? null
      : h("button", {
          type: "button",
          text: skill.state === "active" ? "停用 Skill" : "启用 Skill",
          onclick: () => setEnabled(skill, skill.state !== "active"),
        });
    return h(
      "div",
      {},
      h("div", { class: "card-head" }, h("h2", { class: "view-title" }, skill.name || skill.skill_id, badge(skill.state, skill.state === "active" ? "ok" : "warn")), h("span", { class: "spacer" }), enableToggle),
      kv([
        ["skill_id", h("span", { class: "mono", text: skill.skill_id })],
        ["description", skill.description || DASH],
        ["triggers", listOrDash(skill.triggers)],
        ["tags", listOrDash(skill.tags)],
        ["visibility", skill.visibility],
        ["current_version", `v${skill.current_version}`],
        ["创建", clock(skill.created_at)],
        ["更新", clock(skill.updated_at)],
      ]),
      sectionTitle(`版本历史（${versions.length}）`),
      h("p", { class: "meta", text: "版本永不重写：每个版本的 content_hash 对应当次写入的正文与资源文件。" }),
      versions.length ? versions.map(versionCard) : empty("没有版本记录", "该资产尚无已写入的版本。"),
    );
  }

  async function setEnabled(skill, enabled) {
    try {
      detail = await app.api.request(`/skills/${encodeURIComponent(skill.skill_id)}/enabled`, {
        method: "POST",
        body: { enabled },
      });
      items = items.map((item) => (item.skill_id === detail.skill_id ? { ...item, state: detail.state, updated_at: detail.updated_at } : item));
      error = null;
    } catch (failure) {
      error = failure;
    }
    render();
  }

  function archiveCard(archive) {
    return card(
      [
        h(
          "div",
          { class: "card-head" },
          h("span", { class: "mono", text: shortId(archive.archive_id, 14), title: archive.archive_id }),
          tag(archive.reason),
          h("span", { class: "spacer" }),
          h("span", { class: "meta", text: clock(archive.created_at) }),
        ),
        h("div", { class: "meta", text: `${archive.session_id} · 来源归档 ${shortId(archive.source_archive_id, 12)}` }),
        h(
          "div",
          { class: "meta" },
          `turn ${archive.turn_count} · 成功工具调用 ${archive.successful_tool_calls} · ${bytes(archive.bytes_count)} · 格式 v${archive.trace_format_version}`,
        ),
        h("div", { class: "meta", text: `payload_hash ${shortId(archive.payload_hash, 16)}` }),
      ],
      { selected: selected === archive.archive_id, onClick: () => select(archive.archive_id) },
    );
  }

  function archiveDetail(archive) {
    const nodes = [
      h("h2", { class: "view-title" }, "来源归档", h("span", { class: "mono", text: shortId(archive.archive_id, 16), title: archive.archive_id })),
      kv([
        ["session", h("span", { class: "mono", text: archive.session_id })],
        ["来源归档", h("span", { class: "mono", text: archive.source_archive_id })],
        ["reason", archive.reason],
        ["payload_hash", h("span", { class: "mono", text: archive.payload_hash })],
        ["创建", clock(archive.created_at)],
        ["turn 数", count(archive.turn_count)],
        ["成功工具调用", count(archive.successful_tool_calls)],
        ["字节数", bytes(archive.bytes_count)],
        ["格式版本", archive.trace_format_version],
      ]),
      sectionTitle(`随归档一起物化的 L0 归档（${archive.archives.length}）`),
    ];
    for (const inner of archive.archives) {
      nodes.push(
        card([
          h(
            "div",
            { class: "card-head" },
            h("span", { class: "mono", text: shortId(inner.archive_id, 14) }),
            h("span", { class: "spacer" }),
            h("span", { class: "meta", text: clock(inner.created_at) }),
          ),
          kv([
            ["lane", inner.lane],
            ["operation", h("span", { class: "mono", text: inner.operation_id })],
            ["items", count(inner.items.length)],
            ["storage 序号", h("span", { class: "meta", text: "（按归档内顺序）" })],
          ]),
        ]),
      );
    }
    if (!archive.archives.length) nodes.push(h("p", { class: "meta", text: "该归档没有随附 trace 数据。" }));
    return h("div", {}, nodes);
  }

  function jobsTable() {
    return table(
      [
        { label: "job", render: (job) => shortId(job.job_id, 14) },
        { label: "archive", render: (job) => shortId(job.archive_id, 14) },
        { label: "status", render: (job) => badge(job.status, job.status === "dead_letter" ? "bad" : job.status === "completed" ? "ok" : "warn") },
        { label: "attempt", render: (job) => job.attempt },
        { label: "not_before", render: (job) => clock(job.not_before) },
        { label: "lease", render: (job) => (job.lease_id ? `${shortId(job.lease_id, 8)} → ${clock(job.lease_until)}` : DASH) },
        { label: "candidates", render: (job) => listOrDash(job.candidate_skill_ids.map((id) => shortId(id, 10))) },
        { label: "prompt", render: (job) => (job.prompt_id ? `${job.prompt_id} v${job.prompt_version}` : DASH) },
        { label: "error", render: (job) => job.error_class || DASH },
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

  function listColumn() {
    const nodes = [
      h(
        "div",
        { class: "card-head" },
        h("span", { class: "meta", text: `${items.length} 条` }),
        h("span", { class: "spacer" }),
        tab === "skills" ? stateSelector() : null,
      ),
    ];
    if (!items.length) nodes.push(empty("没有记录", "该视图当前没有可浏览的条目。"));
    if (tab === "skills") nodes.push(...items.map(skillCard));
    else if (tab === "archives") nodes.push(...items.map(archiveCard));
    if (nextCursor) nodes.push(h("div", { class: "pager" }, h("button", { type: "button", text: "加载更多", onClick: () => loadMore() })));
    return nodes;
  }

  function body() {
    if (loading) return [h("p", { class: "meta", text: "读取中…" })];
    if (tab === "jobs") return items.length ? [jobsTable()] : [empty("没有提取任务", "归档达到阈值后才会排入提取任务；队列为空时这里保持为空。")];
    if (tab === "audit") return items.length ? [auditTable()] : [empty("没有审计记录", "该 store 还没有写入审计事件。")];
    if (!selected) {
      return [
        h("div", { class: "split" }, h("div", { class: "list" }, listColumn()), h("div", {}, empty("未选择条目", "在左侧选择一条记录查看详情。"))),
      ];
    }
    if (!detail) return [h("p", { class: "meta", text: "读取中…" })];
    return [
      h(
        "div",
        { class: "split" },
        h("div", { class: "list" }, listColumn()),
        h("div", {}, tab === "skills" ? skillDetail(detail) : archiveDetail(detail)),
      ),
    ];
  }

  function select(id) {
    selected = id;
    loadDetail()
      .then(render)
      .catch((failure) => {
        error = failure;
        render();
      });
  }

  async function loadDetail() {
    if (!selected) {
      detail = null;
      versions = [];
      return;
    }
    if (tab === "skills") {
      detail = await app.api.request(`/skills/${encodeURIComponent(selected)}`);
      const page = await app.api.request(`/skills/${encodeURIComponent(selected)}/versions`, { query: { limit: 25 } });
      versions = page.items;
    } else {
      detail = await app.api.request(`/skills/archives/${encodeURIComponent(selected)}`);
      versions = [];
    }
  }

  const PATHS = { skills: "/skills", archives: "/skills/archives", jobs: "/skills/jobs", audit: "/skills/audit" };

  async function fetchPage(cursor, appendItems) {
    const page = await app.api.request(PATHS[tab], {
      query: { limit: 25, cursor, state: tab === "skills" ? stateFilter : undefined },
    });
    items = appendItems ? [...items, ...page.items] : page.items;
    nextCursor = page.next_cursor;
  }

  async function loadMore() {
    await fetchPage(nextCursor, true);
    render();
  }

  async function refresh() {
    loading = true;
    error = null;
    render();
    try {
      await fetchPage(null, false);
      if (selected) await loadDetail();
      else {
        detail = null;
        versions = [];
      }
    } catch (failure) {
      error = failure;
      items = [];
      detail = null;
      versions = [];
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
        items = [];
        nextCursor = null;
        app.navigate({ view: "skills", params: { tab } });
      }),
    );
    if (error) {
      const unavailable = error.status === 503;
      append(
        element,
        notice(
          unavailable ? `该部署未配置技能 store：${errorText(error)}` : errorText(error),
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
      // A tab change through the URL (history navigation, a pasted link) must
      // drop the previous tab's selection: an archive id is not a skill id.
      if (params.tab && params.tab !== tab && TABS.some((item) => item.id === params.tab)) {
        tab = params.tab;
        selected = null;
        detail = null;
        versions = [];
        items = [];
        nextCursor = null;
      }
      if (params.id) selected = params.id;
    },
    refresh,
    onEvent() {},
  };
}

function byteLength(base64) {
  if (typeof base64 !== "string") return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function decodeText(base64) {
  try {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "（无法按 UTF-8 解码该资源）";
  }
}

function dataUrl(file) {
  return `data:${file.mime_type || "application/octet-stream"};base64,${file.content}`;
}
