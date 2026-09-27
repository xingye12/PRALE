import asyncio
import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from urllib.request import Request, urlopen

from agent_harness.runtime.generation import AssistantResult, GenerationDelta, GenerationRequest, ToolCall


@dataclass(frozen=True, slots=True)
class DeepSeekProvider:
    api_key: str
    model: str
    base_url: str = "https://api.deepseek.com/chat/completions"
    timeout_seconds: float = 60.0

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        payload = {
            "model": self.model,
            "messages": list(request.messages),
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                }
                for tool in request.tools
            ],
        }
        response = await asyncio.to_thread(self._post, payload)
        choice = response["choices"][0]
        message = choice["message"]
        return AssistantResult(
            content=message.get("content") or "",
            usage={key: value for key, value in response.get("usage", {}).items() if isinstance(value, (int, float))},
            finish_reason=choice.get("finish_reason") or "stop",
            tool_calls=tuple(
                ToolCall(call["id"], call["function"]["name"], json.loads(call["function"]["arguments"]))
                for call in message.get("tool_calls", [])
            ),
        )

    async def stream(self, request: GenerationRequest) -> AsyncIterator[GenerationDelta | AssistantResult]:
        """Expose OpenAI-compatible SSE without leaking wire events into runtime."""

        payload = {
            "model": self.model,
            "messages": list(request.messages),
            "stream": True,
            "stream_options": {"include_usage": True},
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                }
                for tool in request.tools
            ],
        }
        queue: asyncio.Queue[dict | BaseException | None] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def emit(chunk: dict) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, chunk)

        def produce() -> None:
            try:
                self._post_stream(payload, emit)
            except BaseException as error:
                loop.call_soon_threadsafe(queue.put_nowait, error)
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, None)

        producer = asyncio.create_task(asyncio.to_thread(produce))
        content = ""
        usage: dict[str, int | float] = {}
        finish_reason = "stop"
        tool_fragments: dict[int, dict[str, str]] = {}
        while True:
            item = await queue.get()
            if item is None:
                break
            if isinstance(item, BaseException):
                raise item
            chunk = item
            choices = chunk.get("choices", [])
            if choices:
                choice = choices[0]
                delta = choice.get("delta", {})
                part = delta.get("content") or ""
                if part:
                    content += part
                    yield GenerationDelta(part)
                raw_tool_calls = delta.get("tool_calls", [])
                if not isinstance(raw_tool_calls, list):
                    raise RuntimeError("provider stream tool_calls must be a list")
                for position, raw_call in enumerate(raw_tool_calls):
                    if not isinstance(raw_call, dict):
                        raise RuntimeError("provider stream tool call must be an object")
                    index = raw_call.get("index", position)
                    if not isinstance(index, int):
                        raise RuntimeError("provider stream tool call index must be an integer")
                    fragment = tool_fragments.setdefault(index, {})
                    call_id = raw_call.get("id")
                    if isinstance(call_id, str):
                        fragment["id"] = call_id
                    function = raw_call.get("function", {})
                    if not isinstance(function, dict):
                        raise RuntimeError("provider stream tool call function must be an object")
                    name = function.get("name")
                    if isinstance(name, str):
                        fragment["name"] = name
                    arguments = function.get("arguments")
                    if isinstance(arguments, str):
                        fragment["arguments"] = fragment.get("arguments", "") + arguments
                finish_reason = choice.get("finish_reason") or finish_reason
            chunk_usage = chunk.get("usage", {})
            if isinstance(chunk_usage, dict):
                usage.update({key: value for key, value in chunk_usage.items() if isinstance(value, (int, float))})
        await producer
        tool_calls: list[ToolCall] = []
        for index, fragment in sorted(tool_fragments.items()):
            call_id = fragment.get("id")
            name = fragment.get("name")
            arguments = fragment.get("arguments")
            if not isinstance(call_id, str) or not isinstance(name, str) or not isinstance(arguments, str):
                raise RuntimeError(f"provider stream tool call {index} was incomplete")
            decoded_arguments = json.loads(arguments)
            if not isinstance(decoded_arguments, dict):
                raise RuntimeError(f"provider stream tool call {index} arguments must decode to an object")
            tool_calls.append(ToolCall(call_id, name, decoded_arguments))
        yield AssistantResult(content=content, usage=usage, finish_reason=finish_reason, tool_calls=tuple(tool_calls))

    def _post(self, payload: dict) -> dict:
        request = Request(
            self.base_url,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
            return json.loads(response.read())

    def _post_stream(self, payload: dict, on_chunk: Callable[[dict], None]) -> None:
        request = Request(
            self.base_url,
            data=json.dumps(payload).encode(),
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=self.timeout_seconds) as response:  # noqa: S310
            for raw_line in response:
                line = raw_line.decode().strip()
                if not line.startswith("data:"):
                    continue
                data = line.removeprefix("data:").strip()
                if data == "[DONE]":
                    break
                on_chunk(json.loads(data))
