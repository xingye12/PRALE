// Display contract (spec §4 展示契约).
//
// The durable record is the authority: a value it cannot prove is rendered as
// a dash, never as zero, and no duration is ever re-derived from timestamps.
// Call durations come from ``duration_ms``, which the domain computes; the
// turn duration comes from the same field on the turn summary.

export const DASH = "—";
export const RESULT_UNKNOWN = "结果未知";
export const NOT_RECORDED = "不可用（未记录）";
export const UNRESOLVED = "未结算";

const STATUS_TONES = {
  completed: ["已完成", "ok"],
  declined: ["已拒绝", "warn"],
  aborted: ["已中止", "warn"],
  failed: ["失败", "bad"],
  unknown: [RESULT_UNKNOWN, "unknown"],
};

const OUTCOME_TONES = {
  completed: ["完成", "ok"],
  failed: ["失败", "bad"],
  aborted: ["中止", "warn"],
  unknown: [RESULT_UNKNOWN, "unknown"],
  pending: [UNRESOLVED, "pending"],
};

export function dash(value) {
  if (value === null || value === undefined || value === "") return DASH;
  return String(value);
}

export function count(value) {
  return value === null || value === undefined ? DASH : String(value);
}

/** Wall-clock for a millisecond epoch; ``null`` stays a dash. */
export function clock(value) {
  if (value === null || value === undefined) return DASH;
  return new Date(value).toLocaleString();
}

/** A duration the domain computed, or a dash when no duration is provable. */
export function duration(value) {
  if (value === null || value === undefined) return DASH;
  return humanMs(value);
}

export function humanMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Status badge for an operation. ``null`` is not a success and not a failure:
 * the durable record only proves the operation has not settled, so liveness is
 * never claimed here.
 */
export function operationStatus(status) {
  if (status === null || status === undefined) {
    return { label: UNRESOLVED, tone: "pending", detail: "durable 记录中该 operation 尚未结算；是否仍在运行由服务进程决定" };
  }
  const [label, tone] = STATUS_TONES[status] || [status, "pending"];
  return { label, tone, detail: null };
}

export function spanOutcome(outcome) {
  const [label, tone] = OUTCOME_TONES[outcome] || [outcome, "pending"];
  return { label, tone };
}

export function shortId(value, width = 8) {
  if (!value) return DASH;
  const text = String(value);
  return text.length <= width + 1 ? text : `${text.slice(0, width)}…`;
}

export function jsonText(value) {
  if (value === null || value === undefined) return DASH;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function bytes(value) {
  if (value === null || value === undefined) return DASH;
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MiB`;
}

export function listOrDash(items) {
  if (!items || !items.length) return DASH;
  return items.join(", ");
}

export function errorText(error) {
  if (!error) return "";
  if (error.body && typeof error.body.error === "string") return error.body.error;
  return error.message || String(error);
}
