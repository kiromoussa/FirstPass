import base64
import json
import re

from anthropic import AsyncAnthropic
from PIL import Image

from app.config import settings
from app.models.schemas import ExtractedElements
from app.services.pdf_converter import image_to_bytes

EXTRACTION_PROMPT = """You are an architectural floor plan reviewer.

Analyze this residential floor plan.

Identify:
- rooms
- room labels
- doors
- windows
- stairs
- dimensions visible on the drawing
- notable layout features

Return ONLY valid JSON.

Schema:

{
  "rooms": [],
  "doors": [],
  "windows": [],
  "stairs": [],
  "dimensions": [],
  "potential_issues": []
}

Requirements:
- Do not invent measurements.
- Only report dimensions explicitly visible.
- If uncertain, say "unclear".
- Focus on extraction accuracy."""


def parse_json_response(raw: str) -> dict:
    """Extract and parse JSON from a model response, tolerating markdown fences."""
    text = raw.strip()
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if fence_match:
        text = fence_match.group(1).strip()
    return json.loads(text)


def normalize_extraction(data: dict) -> dict:
    """Coerce loosely shaped model output into schema-compatible structures."""
    normalized = dict(data)

    issues = normalized.get("potential_issues", [])
    normalized["potential_issues"] = [
        item if isinstance(item, str) else item.get("description", str(item))
        for item in issues
    ]

    for key in ("rooms", "doors", "windows", "stairs", "dimensions"):
        items = normalized.get(key, [])
        coerced = []
        for item in items:
            if isinstance(item, str):
                if key == "rooms":
                    coerced.append({"name": item, "label": None, "notes": None})
                elif key == "dimensions":
                    coerced.append(
                        {"label": "unclear", "value": item, "unit": "ft", "location": None}
                    )
                else:
                    coerced.append({"location": item, "notes": None})
            else:
                coerced.append(item)
        normalized[key] = coerced

    return normalized


class VisionAnalyzer:
    def __init__(self) -> None:
        self._client: AsyncAnthropic | None = None

    @property
    def client(self) -> AsyncAnthropic:
        if not settings.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not configured. Set it in backend/.env to enable analysis."
            )
        if self._client is None:
            self._client = AsyncAnthropic(api_key=settings.anthropic_api_key)
        return self._client

    async def extract_elements(self, image: Image.Image) -> ExtractedElements:
        """Analyze a floor plan PNG with Claude Sonnet 4 Vision."""
        image_b64 = base64.b64encode(image_to_bytes(image)).decode("utf-8")

        response = await self.client.messages.create(
            model=settings.anthropic_model,
            max_tokens=4096,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": image_b64,
                            },
                        },
                        {"type": "text", "text": EXTRACTION_PROMPT},
                    ],
                }
            ],
        )

        text_blocks = [block.text for block in response.content if block.type == "text"]
        raw = "\n".join(text_blocks) if text_blocks else "{}"
        data = normalize_extraction(parse_json_response(raw))
        return ExtractedElements.model_validate(data)
