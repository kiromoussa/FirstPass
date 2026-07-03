"""OpenAI adapter for Band agents — mirrors band.adapters.anthropic.AnthropicAdapter's
SimpleAdapter pattern (tool loop, per-room conversation history), but calls the OpenAI
Chat Completions API instead of Anthropic's Messages API.

band-sdk ships AnthropicAdapter and PydanticAIAdapter, but no adapter that talks to
OpenAI's API directly. Rather than rewrite FirstPass's tool surface (ARCHIVE_SCRAPE_TOOLS,
BROWSERBASE_TOOLS, PLAN_ANALYSIS_TOOLS, ...) into PydanticAIAdapter's function-signature
convention, this reuses band's existing provider-agnostic tool-schema conversion
(`custom_tools_to_schemas(tools, "openai")`) and platform-tool schemas
(`tools.get_openai_tool_schemas()`) — both already ship OpenAI-format output — so every
existing CustomToolDef tool works unchanged.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, ClassVar

from openai import AsyncOpenAI

from band.core.exceptions import BandConfigError
from band.core.protocols import AgentToolsProtocol, HistoryConverter
from band.core.simple_adapter import SimpleAdapter
from band.core.types import AdapterFeatures, Capability, Emit, PlatformMessage
from band.converters._tool_parsing import parse_tool_call, parse_tool_result
from band.runtime.custom_tools import (
    CustomToolDef,
    custom_tools_to_schemas,
    execute_custom_tool,
    find_custom_tool,
)
from band.runtime.prompts import render_system_prompt

logger = logging.getLogger(__name__)

# OpenAI chat message: {"role": ..., "content": ..., "tool_calls"?: [...], "tool_call_id"?: ...}
OpenAIMessages = list[dict[str, Any]]


class OpenAIHistoryConverter(HistoryConverter[OpenAIMessages]):
    """
    Converts platform history to OpenAI chat-completions message format.

    Unlike Anthropic (which batches tool_use/tool_result blocks into one
    assistant/user message each), OpenAI wants one assistant message with a
    `tool_calls` array, followed by one `role: "tool"` message PER call.
    """

    def __init__(self, agent_name: str = ""):
        self._agent_name = agent_name

    def set_agent_name(self, name: str) -> None:
        self._agent_name = name

    def convert(self, raw: list[dict[str, Any]]) -> OpenAIMessages:
        messages: OpenAIMessages = []
        pending_tool_calls: list[dict[str, Any]] = []

        def flush_tool_calls() -> None:
            if pending_tool_calls:
                messages.append(
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": c["id"],
                                "type": "function",
                                "function": {"name": c["name"], "arguments": json.dumps(c["args"])},
                            }
                            for c in pending_tool_calls
                        ],
                    }
                )
                pending_tool_calls.clear()

        for hist in raw:
            message_type = hist.get("message_type", "text")
            content = hist.get("content", "")

            if message_type == "tool_call":
                parsed = parse_tool_call(content)
                if parsed:
                    pending_tool_calls.append(
                        {"id": parsed.tool_call_id, "name": parsed.name, "args": parsed.args}
                    )
            elif message_type == "tool_result":
                flush_tool_calls()
                parsed = parse_tool_result(content)
                if parsed:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": parsed.tool_call_id,
                            "content": parsed.output,
                        }
                    )
            elif message_type == "text":
                flush_tool_calls()
                role = hist.get("role", "user")
                sender_name = hist.get("sender_name", "")
                if role == "assistant" and sender_name == self._agent_name:
                    continue  # skip this agent's own text — redundant with tool results
                messages.append(
                    {
                        "role": "user",
                        "content": f"[{sender_name}]: {content}" if sender_name else content,
                    }
                )

        flush_tool_calls()
        return messages


class OpenAIAdapter(SimpleAdapter[OpenAIMessages]):
    """
    OpenAI Chat Completions adapter using the SimpleAdapter pattern.

    Example:
        adapter = OpenAIAdapter(
            model="gpt-5-mini",
            custom_section="You are a helpful assistant.",
            additional_tools=MY_TOOLS,
        )
        agent = Agent.create(adapter=adapter, agent_id="...", api_key="...")
        await agent.run()
    """

    SUPPORTED_EMIT: ClassVar[frozenset[Emit]] = frozenset({Emit.EXECUTION})
    SUPPORTED_CAPABILITIES: ClassVar[frozenset[Capability]] = frozenset(
        {Capability.MEMORY, Capability.CONTACTS}
    )

    def __init__(
        self,
        model: str = "gpt-5-mini",
        provider_key: str | None = None,
        system_prompt: str | None = None,
        prompt: str | None = None,
        max_tokens: int = 4096,
        history_converter: OpenAIHistoryConverter | None = None,
        additional_tools: list[CustomToolDef] | None = None,
        features: AdapterFeatures | None = None,
        include_base_instructions: bool = True,
        # --- Compat with AnthropicAdapter's now-deprecated kwargs ---
        custom_section: str | None = None,
        enable_execution_reporting: bool = False,
    ):
        if custom_section is not None:
            if prompt is not None:
                raise BandConfigError("Cannot pass both prompt and custom_section")
            prompt = custom_section

        if enable_execution_reporting:
            if features is not None:
                raise BandConfigError(
                    "Cannot pass both features= and enable_execution_reporting"
                )
            features = AdapterFeatures(emit=frozenset({Emit.EXECUTION}))

        super().__init__(
            history_converter=history_converter or OpenAIHistoryConverter(),
            features=features,
        )

        self.model = model
        self.system_prompt = system_prompt
        self._prompt = prompt
        self._include_base_instructions = include_base_instructions
        self.max_tokens = max_tokens
        # Reasoning models (gpt-5*/o*) spend completion budget on reasoning
        # tokens and reject legacy sampling params — mirror the TS adapter's gate.
        self._reasoning = bool(re.match(r"^(gpt-5|o\d)", model))

        self.client = AsyncOpenAI(api_key=provider_key)

        self._message_history: dict[str, OpenAIMessages] = {}
        self._system_prompt: str = ""
        self._custom_tools: list[CustomToolDef] = additional_tools or []

    async def on_started(self, agent_name: str, agent_description: str) -> None:
        await super().on_started(agent_name, agent_description)
        if isinstance(self.history_converter, OpenAIHistoryConverter):
            self.history_converter.set_agent_name(agent_name)
        self._system_prompt = self.system_prompt or render_system_prompt(
            agent_name=agent_name,
            agent_description=agent_description,
            custom_section=self._prompt or "",
            include_base_instructions=self._include_base_instructions,
            features=self.features,
        )
        logger.info("OpenAI adapter started for agent: %s", agent_name)

    async def on_message(
        self,
        msg: PlatformMessage,
        tools: AgentToolsProtocol,
        history: OpenAIMessages,
        participants_msg: str | None,
        contacts_msg: str | None,
        *,
        is_session_bootstrap: bool,
        room_id: str,
    ) -> None:
        logger.debug("Handling message %s in room %s", msg.id, room_id)

        if is_session_bootstrap:
            self._message_history[room_id] = list(history) if history else []
            logger.info("Room %s: Loaded %s historical messages", room_id, len(self._message_history[room_id]))
        elif room_id not in self._message_history:
            self._message_history[room_id] = []

        if participants_msg:
            self._message_history[room_id].append({"role": "user", "content": f"[System]: {participants_msg}"})
        if contacts_msg:
            self._message_history[room_id].append({"role": "user", "content": f"[System]: {contacts_msg}"})

        self._message_history[room_id].append({"role": "user", "content": msg.format_for_llm()})

        include_memory = Capability.MEMORY in self.features.capabilities
        include_contacts = Capability.CONTACTS in self.features.capabilities
        tool_schemas = list(tools.get_openai_tool_schemas(include_memory=include_memory, include_contacts=include_contacts))
        if self._custom_tools:
            tool_schemas.extend(custom_tools_to_schemas(self._custom_tools, "openai"))

        while True:
            try:
                response = await self._call_openai(
                    messages=self._message_history[room_id],
                    tools=tool_schemas,
                )
            except Exception as e:
                logger.error("Error calling OpenAI: %s", e, exc_info=True)
                await self._report_error(tools, str(e))
                raise

            choice = response.choices[0]
            tool_calls = choice.message.tool_calls or []

            if not tool_calls:
                text_content = choice.message.content or ""
                if text_content:
                    self._message_history[room_id].append({"role": "assistant", "content": text_content})
                logger.debug(
                    "Room %s: Completed with finish_reason=%s", room_id, choice.finish_reason
                )
                break

            self._message_history[room_id].append(
                {
                    "role": "assistant",
                    "content": choice.message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                        }
                        for tc in tool_calls
                    ],
                }
            )

            tool_results = await self._process_tool_calls(tool_calls, tools)
            self._message_history[room_id].extend(tool_results)

        logger.debug(
            "Message %s processed successfully (history now has %s messages)",
            msg.id,
            len(self._message_history[room_id]),
        )

    async def on_cleanup(self, room_id: str) -> None:
        if room_id in self._message_history:
            del self._message_history[room_id]
            logger.debug("Room %s: Cleaned up message history", room_id)

    async def _call_openai(
        self,
        messages: OpenAIMessages,
        tools: list[dict[str, Any]],
    ) -> Any:
        full_messages: OpenAIMessages = [{"role": "system", "content": self._system_prompt}, *messages]
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": full_messages,
            "max_completion_tokens": self.max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
        if self._reasoning:
            kwargs["reasoning_effort"] = "low"
        return await self.client.chat.completions.create(**kwargs)

    async def _process_tool_calls(
        self, tool_calls: list[Any], tools: AgentToolsProtocol
    ) -> OpenAIMessages:
        results: OpenAIMessages = []

        for call in tool_calls:
            tool_name = call.function.name
            tool_call_id = call.id
            try:
                tool_input = json.loads(call.function.arguments or "{}")
            except json.JSONDecodeError:
                tool_input = {}

            logger.debug("Executing tool: %s with input: %s", tool_name, tool_input)

            if Emit.EXECUTION in self.features.emit:
                try:
                    await tools.send_event(
                        content=json.dumps({"name": tool_name, "args": tool_input, "tool_call_id": tool_call_id}),
                        message_type="tool_call",
                    )
                except Exception as e:
                    logger.warning("Failed to send tool_call event: %s", e)

            try:
                custom_tool = find_custom_tool(self._custom_tools, tool_name)
                if custom_tool:
                    result = await execute_custom_tool(custom_tool, tool_input)
                else:
                    result = await tools.execute_tool_call(tool_name, tool_input)
                result_str = json.dumps(result, default=str) if not isinstance(result, str) else result
                is_error = False
            except Exception as e:
                result_str = f"Error: {e}"
                is_error = True
                logger.error("Tool %s failed: %s", tool_name, e)

            if Emit.EXECUTION in self.features.emit:
                try:
                    await tools.send_event(
                        content=json.dumps(
                            {"name": tool_name, "output": result_str, "tool_call_id": tool_call_id, "is_error": is_error}
                        ),
                        message_type="tool_result",
                    )
                except Exception as e:
                    logger.warning("Failed to send tool_result event: %s", e)

            results.append({"role": "tool", "tool_call_id": tool_call_id, "content": result_str})

        return results

    async def _report_error(self, tools: AgentToolsProtocol, error: str) -> None:
        try:
            await tools.send_event(content=f"Error: {error}", message_type="error")
        except Exception as e:
            logger.warning("Failed to send error event: %s", e)
