import json

import pytest
from PIL import Image

from app.services.vision_analyzer import VisionAnalyzer, normalize_extraction, parse_json_response


def test_parse_json_response_strips_fences():
    raw = '```json\n{"rooms": []}\n```'
    assert parse_json_response(raw) == {"rooms": []}


def test_normalize_extraction_coerces_string_items():
    data = {
        "rooms": ["Kitchen"],
        "doors": [],
        "windows": [],
        "stairs": [],
        "dimensions": ['12\'-0"'],
        "potential_issues": [{"description": "Narrow hallway", "certainty": "unclear"}],
    }
    normalized = normalize_extraction(data)
    assert normalized["rooms"][0]["name"] == "Kitchen"
    assert normalized["dimensions"][0]["value"] == '12\'-0"'
    assert normalized["potential_issues"] == ["Narrow hallway"]


@pytest.mark.asyncio
async def test_extract_elements_calls_claude(monkeypatch):
    image = Image.new("RGB", (100, 100), color="white")
    captured: dict = {}

    class MockMessages:
        @staticmethod
        async def create(**kwargs):
            captured.update(kwargs)

            class Block:
                type = "text"
                text = json.dumps(
                    {
                        "rooms": [{"name": "Bedroom", "label": "BR", "notes": None}],
                        "doors": [],
                        "windows": [],
                        "stairs": [],
                        "dimensions": [],
                        "potential_issues": [],
                    }
                )

            class Response:
                content = [Block()]

            return Response()

    class MockClient:
        messages = MockMessages()

    monkeypatch.setattr("app.services.vision_analyzer.settings.anthropic_api_key", "test-key")
    monkeypatch.setattr(
        "app.services.vision_analyzer.AsyncAnthropic",
        lambda **kwargs: MockClient(),
    )

    analyzer = VisionAnalyzer()
    result = await analyzer.extract_elements(image)

    assert captured["model"] == "claude-sonnet-4-6"
    content = captured["messages"][0]["content"]
    assert content[0]["type"] == "image"
    assert content[0]["source"]["media_type"] == "image/png"
    assert content[1]["text"]
    assert len(result.rooms) == 1
    assert result.rooms[0].name == "Bedroom"
    assert result.rooms[0].label == "BR"
