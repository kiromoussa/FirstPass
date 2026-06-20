"""Band REST client for orchestrating multi-agent code research rooms."""

from __future__ import annotations

import os
from typing import Any

import httpx


class BandClient:
    def __init__(self, api_key: str, base_url: str | None = None):
        self.api_key = api_key
        self.base_url = (base_url or os.getenv("BAND_REST_URL") or "https://app.band.ai/api/v1/agent").rstrip(
            "/"
        )
        self._headers = {"X-API-Key": api_key, "Content-Type": "application/json"}

    def _request(self, method: str, path: str, json: dict | None = None) -> dict[str, Any]:
        with httpx.Client(timeout=30.0) as client:
            response = client.request(method, f"{self.base_url}{path}", headers=self._headers, json=json)
            response.raise_for_status()
            if response.status_code == 204:
                return {}
            return response.json()

    def me(self) -> dict[str, Any]:
        payload = self._request("GET", "/me")
        return payload.get("data", payload)

    def create_chat(self, task_id: str | None = None) -> dict[str, Any]:
        chat: dict[str, Any] = {}
        if task_id:
            chat["task_id"] = task_id
        payload = self._request("POST", "/chats", json={"chat": chat})
        return payload.get("data", payload)

    def add_participant(self, chat_id: str, participant_id: str, role: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"participant_id": participant_id}
        if role:
            body["role"] = role
        payload = self._request(
            "POST",
            f"/chats/{chat_id}/participants",
            json={"participant": body},
        )
        return payload.get("data", payload)

    def add_owner(self, chat_id: str) -> dict[str, Any] | None:
        """Add the human account that owns this agent so they can chat in the room."""
        profile = self.me()
        owner_id = profile.get("owner_uuid")
        if not owner_id:
            return None
        try:
            return self.add_participant(chat_id, owner_id, role="member")
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 409:
                return {"status": "already_in_room", "id": owner_id}
            raise

    def list_participants(self, chat_id: str) -> list[dict[str, Any]]:
        payload = self._request("GET", f"/chats/{chat_id}/participants")
        data = payload.get("data", payload)
        if isinstance(data, list):
            return data
        return data.get("participants", [])

    def send_message(
        self,
        chat_id: str,
        content: str,
        mentions: list[dict[str, str]],
    ) -> dict[str, Any]:
        payload = self._request(
            "POST",
            f"/chats/{chat_id}/messages",
            json={"message": {"content": content, "mentions": mentions}},
        )
        return payload.get("data", payload)
