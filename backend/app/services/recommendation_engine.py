import json
import re

from anthropic import AsyncAnthropic

from app.config import settings
from app.models.schemas import RecommendationRequest, RecommendationResponse

RECOMMENDATION_PROMPT = """You are an expert residential code consultant and architect.

Given known code violations and optional floor plan context, generate actionable design recommendations to resolve each violation.

Return ONLY valid JSON matching this schema:

{{
  "recommendations": [
    {{
      "violation": "",
      "code_section": "",
      "severity": "",
      "recommended_fix": "",
      "design_adjustment": "",
      "drawing_location": {{
        "sheet": "",
        "area": "",
        "bbox": null,
        "annotation_text": ""
      }},
      "confidence": "",
      "notes": ""
    }}
  ]
}}

Requirements:
- Provide one recommendation object per input violation.
- Do not invent exact dimensions, coordinates, or sheet numbers.
- If bbox coordinates are unavailable, set bbox to null and describe location textually in drawing_location.area and annotation_text.
- Use confidence values: high, medium, or low.
- Preserve the input code_section and severity unless clarification is needed in notes.
- recommended_fix should describe the corrective action.
- design_adjustment should describe plan/layout changes needed.

Input:
{input_json}"""


def parse_json_response(raw: str) -> dict:
    """Extract and parse JSON from a model response, tolerating markdown fences."""
    text = raw.strip()
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    if fence_match:
        text = fence_match.group(1).strip()
    return json.loads(text)


class RecommendationEngine:
    def __init__(self) -> None:
        self._client: AsyncAnthropic | None = None

    @property
    def client(self) -> AsyncAnthropic:
        if not settings.anthropic_api_key_configured:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not configured. Set it in backend/.env to enable recommendations."
            )
        if self._client is None:
            self._client = AsyncAnthropic(api_key=settings.anthropic_api_key)
        return self._client

    async def generate(self, request: RecommendationRequest) -> RecommendationResponse:
        prompt = RECOMMENDATION_PROMPT.format(
            input_json=request.model_dump_json(indent=2)
        )

        response = await self.client.messages.create(
            model=settings.anthropic_model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )

        text_blocks = [block.text for block in response.content if block.type == "text"]
        raw = "\n".join(text_blocks) if text_blocks else '{"recommendations": []}'
        data = parse_json_response(raw)
        return RecommendationResponse.model_validate(data)
