import asyncio
from unittest.mock import patch

from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.runtime.generation import (
    AssistantResult,
    GenerationDelta,
    GenerationRequest,
    ToolCall,
    ToolDefinition,
)


def test_deepseek_provider_maps_openai_compatible_tool_response() -> None:
    async def scenario() -> None:
        provider = DeepSeekProvider("secret", "deepseek-chat")
        response = {
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": None,
                        "tool_calls": [
                            {"id": "call-1", "function": {"name": "echo", "arguments": '{"value":"hi"}'}},
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 3, "completion_tokens": 2},
        }
        with patch.object(DeepSeekProvider, "_post", return_value=response) as post:
            result = await provider.generate(
                GenerationRequest(
                    "session-1",
                    "main",
                    "op-1",
                    ({"role": "user", "content": "hi"},),
                    (ToolDefinition("echo", "Echo", {"type": "object"}),),
                )
            )

        assert result.tool_calls[0].arguments == {"value": "hi"}
        assert result.usage == {"prompt_tokens": 3, "completion_tokens": 2}
        assert post.call_args.args[0]["tools"][0]["function"]["name"] == "echo"

    asyncio.run(scenario())


def test_deepseek_provider_exposes_sse_chunks_before_its_final_result() -> None:
    async def scenario() -> None:
        provider = DeepSeekProvider("secret", "deepseek-chat")

        def post_stream(payload, emit):
            emit({"choices": [{"delta": {"content": "hel"}, "finish_reason": None}], "usage": None})
            emit(
                {
                    "choices": [{"delta": {"content": "lo"}, "finish_reason": "stop"}],
                    "usage": {"completion_tokens": 2},
                }
            )

        with patch.object(DeepSeekProvider, "_post_stream", side_effect=post_stream):
            frames = [
                frame
                async for frame in provider.stream(
                    GenerationRequest("session-1", "main", "op-1", ({"role": "user", "content": "hi"},))
                )
            ]

        assert frames[:2] == [GenerationDelta("hel"), GenerationDelta("lo")]
        assert frames[-1] == AssistantResult(content="hello", usage={"completion_tokens": 2})

    asyncio.run(scenario())


def test_deepseek_provider_reassembles_streamed_tool_calls() -> None:
    async def scenario() -> None:
        provider = DeepSeekProvider("secret", "deepseek-chat")

        def post_stream(payload, emit):
            emit(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call-read",
                                        "type": "function",
                                        "function": {"name": "read", "arguments": '{"path":"'},
                                    }
                                ]
                            },
                            "finish_reason": None,
                        }
                    ]
                }
            )
            emit(
                {
                    "choices": [
                        {
                            "delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'README.md"}'}}]},
                            "finish_reason": "tool_calls",
                        }
                    ],
                    "usage": {"completion_tokens": 4},
                }
            )

        with patch.object(DeepSeekProvider, "_post_stream", side_effect=post_stream):
            frames = [
                frame
                async for frame in provider.stream(
                    GenerationRequest("session-1", "main", "op-1", ({"role": "user", "content": "inspect"},))
                )
            ]

        assert frames == [
            AssistantResult(
                content="",
                usage={"completion_tokens": 4},
                finish_reason="tool_calls",
                tool_calls=(ToolCall("call-read", "read", {"path": "README.md"}),),
            )
        ]

    asyncio.run(scenario())
