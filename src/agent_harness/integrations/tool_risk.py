"""Conservative local tool classification; independent of replay safety."""

import hashlib
import json
import os
from dataclasses import dataclass, replace
from pathlib import Path

from agent_harness.domain.approvals import RiskAssessment
from agent_harness.domain.entries import JsonValue

POLICY_VERSION = 4


class LocalToolRisk:
    cwd: Path | str
    name: str

    def assess_risk(self, arguments: JsonValue) -> RiskAssessment:

        cwd = str(Path(self.cwd).resolve())
        result = assess_tool(self.name, arguments, cwd)
        path = arguments.get("path") if isinstance(arguments, dict) else None
        target = str((Path(cwd) / path).resolve()) if isinstance(path, str) else ""
        context: dict[str, object] = {
            "class": f"{type(self).__module__}.{type(self).__qualname__}",
            "version": getattr(self, "risk_version", "1"),
        }
        if self.name == "bash":
            context.update(
                prefix=getattr(self, "command_prefix", ()),
                environment={**os.environ, **(getattr(self, "environment", None) or {})},
            )
            if getattr(self, "command_prefix", ()):
                result = replace(result, decision="ask", reason="shell command has an execution prefix")
        capability = hashlib.sha256(json.dumps(context, sort_keys=True).encode()).hexdigest()
        return replace(result, cwd=cwd, target=target, capability_version=capability, policy_version=POLICY_VERSION)


class ScopedReadRisk:
    def assess_risk(self, arguments: JsonValue) -> RiskAssessment:
        return RiskAssessment("allow", "scoped read-only query")


def assess_tool(name: str, arguments: JsonValue, cwd: str) -> RiskAssessment:
    """Classify final, validated arguments. This is not an execution sandbox."""
    if not isinstance(arguments, dict):
        return RiskAssessment("deny", "tool arguments must be an object")
    if name == "bash":
        if arguments.get("command") == "pwd":
            return RiskAssessment("allow", "working directory query")
        return RiskAssessment("ask", "shell execution can modify files or access external systems")
    if name in {"memory_search", "conversation_search", "memory_read_scene", "skill_load"}:
        return RiskAssessment("allow", "scoped read-only query")
    if name not in {"read", "write", "edit"}:
        return RiskAssessment("ask", "tool capabilities have not been classified")
    raw = arguments.get("path")
    if not isinstance(raw, str) or not raw:
        return RiskAssessment("deny", "a nonempty file path is required")
    root = Path(cwd).resolve()
    try:
        target = (root / raw).resolve()
    except (OSError, RuntimeError, ValueError):
        return RiskAssessment("deny", "file path cannot be resolved")
    if name != "read" and not target.is_relative_to(root):
        return RiskAssessment("ask", "path is outside the working directory")
    return RiskAssessment("allow", "file operation within configured write boundary")


@dataclass(frozen=True, slots=True)
class ConfiguredRiskEvaluator:
    """Deployment additions only tighten the tool's native assessment."""

    sensitive_paths: tuple[str, ...] = ()
    protected_paths: tuple[str, ...] = ()

    def __call__(self, name: str, arguments: JsonValue, tool: object) -> RiskAssessment:
        assessor = getattr(tool, "assess_risk", None)
        shell_assessor = getattr(tool, "assess_shell", None)
        if name == "bash" and callable(shell_assessor):
            assessment = shell_assessor(arguments, custom_paths=bool(self.sensitive_paths or self.protected_paths))
        elif callable(assessor):
            assessment = assessor(arguments)
        elif isinstance(getattr(tool, "control_kind", None), str):
            assessment = RiskAssessment("allow", "capability-limited runtime control")
        else:
            assessment = RiskAssessment("ask", "tool capabilities have not been classified")
        if name == "repository_explore" and self.sensitive_paths:
            configured = getattr(getattr(tool, "config", None), "sensitive_paths", ())
            if not set(self.sensitive_paths).issubset(configured):
                return RiskAssessment("deny", "bulk reader does not enforce deployment-sensitive paths")
        if assessment.decision != "deny" and assessment.cwd and isinstance(arguments, dict):
            raw = arguments.get("path")
            if isinstance(raw, str):
                root = Path(assessment.cwd)
                target = (root / raw).resolve()
                candidates = [Path(raw), target]
                if target.is_relative_to(root):
                    candidates.append(target.relative_to(root))
                patterns = self.sensitive_paths + (self.protected_paths if name != "read" else ())
                if any(p.match(pattern) or p.as_posix() == pattern for p in candidates for pattern in patterns):
                    assessment = replace(assessment, decision="ask", reason="deployment-protected path")
        version = hashlib.sha256(json.dumps([self.sensitive_paths, self.protected_paths]).encode()).hexdigest()
        return replace(assessment, capability_version=assessment.capability_version + ":" + version)
