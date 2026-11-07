import asyncio

import httpx

from agent_harness.api.project import ProjectRuntimeConfig
from agent_harness.api.web import create_app
from agent_harness.domain.approvals import ApprovalConfig
from agent_harness.integrations.local_tools import WriteTool
from agent_harness.integrations.tool_risk import ConfiguredRiskEvaluator
from agent_harness.runtime.generation import AssistantResult, ToolCall


class Provider:
    async def generate(self, request):
        if any(isinstance(m, dict) and m.get("role") == "tool" for m in request.messages):
            return AssistantResult("done", {})
        return AssistantResult("", {}, tool_calls=(ToolCall("c", "write", {"path": ".env", "content": "secret"}),))


def test_web_approval_auth_decision_reconnect_and_grant_revocation(tmp_path):
    async def scenario():
        config = ProjectRuntimeConfig(tmp_path, "repo", tmp_path / "sessions", tmp_path / "catalog.db")
        web = create_app(
            config,
            Provider(),
            tools=(WriteTool(tmp_path),),
            tokens={"token": "owner"},
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        await web.start()
        await web.supervisor.create_session("s")
        await web.supervisor.create_session("other")
        transport = httpx.ASGITransport(app=web.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            assert (await client.get("/api/sessions/s/approvals")).status_code == 401
            client.headers["Authorization"] = "Bearer token"
            assert (await client.post("/api/sessions/s/lanes/main/turns", json={"prompt": "write"})).status_code == 202
            for _ in range(100):
                requests = (await client.get("/api/sessions/s/approvals")).json()["items"]
                if requests:
                    break
                await asyncio.sleep(0.001)
            request = requests[0]
            approval_id = request["approval_id"]
            assert not (tmp_path / ".env").exists()
            assert (
                await client.post(
                    f"/api/sessions/other/approvals/{approval_id}/decision", json={"decision": "allow_once"}
                )
            ).status_code == 409
            assert (
                await client.post(
                    f"/api/sessions/s/approvals/{approval_id}/decision",
                    json={"decision": "allow_once", "arguments": {}},
                )
            ).status_code == 400
            assert (
                await client.post(
                    f"/api/sessions/s/approvals/{approval_id}/decision",
                    json={"decision": "allow_once"},
                    headers={"Origin": "https://evil.example"},
                )
            ).status_code == 409
            # The browser can disconnect and re-query the original durable request.
            snapshot = await (await web.supervisor.lane("s", "main")).snapshot()
            assert snapshot.pending_approvals[0]["approval_id"] == approval_id
            await web.aclose()
        # A new server must resume the abandoned lease after approving the same request.
        reopened = create_app(
            config,
            Provider(),
            tools=(WriteTool(tmp_path),),
            tokens={"token": "owner"},
            approvals=ApprovalConfig(
                channel_available=True, evaluator=ConfiguredRiskEvaluator(sensitive_paths=(".env",))
            ),
        )
        await reopened.start()
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=reopened.app),
                base_url="http://testserver",
                headers={"Authorization": "Bearer token"},
            ) as client:
                result = await client.post(
                    f"/api/sessions/s/approvals/{approval_id}/decision", json={"decision": "allow_session"}
                )
                assert result.status_code == 200, result.text
                task = reopened.supervisor.drive_task("s", "main")
                await asyncio.wait_for(task, 2)
                assert (tmp_path / ".env").read_text() == "secret"
                assert (await client.get("/api/sessions/s/approvals")).json()["items"] == []
                assert len((await client.get("/api/sessions/s/approval-grants")).json()["items"]) == 1
                response = await client.post(f"/api/sessions/s/approval-grants/{approval_id}/revoke")
                assert response.status_code == 200 and response.json()["revoked"]
                assert (
                    await client.post(f"/api/sessions/s/approvals/{approval_id}/decision", json={"decision": "reject"})
                ).status_code == 409
        finally:
            await reopened.aclose()

    asyncio.run(scenario())
