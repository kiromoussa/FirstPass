"use client";

import { useEffect, useRef } from "react";
import type { AgentMessage } from "@/lib/types";
import { AGENT_META, MSG_META, SPONSOR_META } from "@/lib/ui";

export function AgentFeed({
  messages,
  autoScroll = false,
}: {
  messages: AgentMessage[];
  /** When true, keeps the feed pinned to the latest message (container only, never the page). */
  autoScroll?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, autoScroll]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-ink-700">
        <h3 className="text-xs uppercase tracking-widest text-muted">Agent activity · Band</h3>
        <span className="text-[10px] text-faint">{messages.length} msgs</span>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-2">
        {messages.length === 0 && (
          <div className="text-xs text-faint px-2 py-4">Waiting for agents…</div>
        )}
        {messages.map((m) => {
          const agent = AGENT_META[m.from];
          const mt = MSG_META[m.type];
          return (
            <div
              key={m.id}
              className="rounded-lg border border-ink-700 bg-ink-800/60 px-3 py-2"
              style={
                m.type === "disagreement"
                  ? { borderColor: "rgba(255,92,92,0.5)" }
                  : m.type === "retry"
                  ? { borderColor: "rgba(255,181,71,0.5)" }
                  : undefined
              }
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-sm">{agent.emoji}</span>
                <span className="text-xs font-medium text-ink">{agent.label}</span>
                {m.to && (
                  <span className="text-[10px] text-muted">→ {AGENT_META[m.to].label}</span>
                )}
                <span
                  className="ml-auto text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                  style={{ color: mt.color, background: `${mt.color}1a` }}
                >
                  {mt.label}
                </span>
              </div>
              <p className="text-xs text-body leading-relaxed">{m.text}</p>
              {m.sponsor && (
                <span
                  className="inline-block mt-1.5 text-[9px] px-1.5 py-0.5 rounded"
                  style={{ color: SPONSOR_META[m.sponsor].color, background: `${SPONSOR_META[m.sponsor].color}1a` }}
                >
                  {SPONSOR_META[m.sponsor].label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
