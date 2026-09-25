import asyncio
from dataclasses import dataclass
from typing import Protocol

from agent_harness.domain.entries import JsonValue
from agent_harness.runtime.generation import ToolDefinition


@dataclass(frozen=True, slots=True)
class ToolExecutionResult:
    content: JsonValue
    is_error: bool = False
    terminate: bool = False
    details: JsonValue | None = None


class AgentTool(Protocol):
    name: str
    description: str
    input_schema: JsonValue
    replay_policy: str

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult: ...


class ToolRegistry:
    def __init__(self, tools: tuple[AgentTool, ...] = ()) -> None:
        by_name = {tool.name: tool for tool in tools}
        if len(by_name) != len(tools):
            raise ValueError("tool names must be unique")
        self._by_name = by_name

    def get(self, name: str) -> AgentTool | None:
        return self._by_name.get(name)

    def definitions(self) -> tuple[ToolDefinition, ...]:
        return tuple(ToolDefinition(tool.name, tool.description, tool.input_schema) for tool in self._by_name.values())

    async def execute_parallel(self, calls: tuple[tuple[str, JsonValue], ...]) -> tuple[ToolExecutionResult, ...]:
        """Execute an already-durable batch concurrently; result order follows source call order."""

        async def execute(name: str, arguments: JsonValue) -> ToolExecutionResult:
            tool = self.get(name)
            if tool is None:
                return ToolExecutionResult(content=f"unknown tool: {name}", is_error=True)
            try:
                return await tool.execute(arguments)
            except Exception as error:
                return ToolExecutionResult(content=f"tool failed: {error}", is_error=True)

        return tuple(await asyncio.gather(*(execute(name, arguments) for name, arguments in calls)))
