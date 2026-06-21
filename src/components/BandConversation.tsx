"use client";

import { useEffect, useRef } from "react";
import type { BandRoomMessage } from "@/lib/types";
import { SPONSOR_META } from "@/lib/ui";

function timeOf(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function RoomMessage({ m }: { m: BandRoomMessage }) {
  const band = SPONSOR_META.band.color;
  const accent =
    m.kind === "agent" ? band : m.kind === "human" ? "#1f8a4c" : "#6b7280";
  const role =
    m.kind === "agent" ? "agent" : m.kind === "human" ? "you" : "orchestrator";

  return (
    <div
      className="rounded-lg border bg-ink-800/60 px-3 py-2"
      style={{ borderColor: `${accent}55` }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: accent }} />
        <span className="text-xs font-medium text-ink truncate">{m.author}</span>
        {m.chatLabel && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-ink-700 text-muted flex-shrink-0">
            {m.chatLabel}
          </span>
        )}
        <span
          className="text-[9px] px-1.5 py-0.5 rounded-full uppercase tracking-wide flex-shrink-0"
          style={{ color: accent, background: `${accent}1a` }}
        >
          {role}
        </span>
        {m.ts > 0 && (
          <span className="ml-auto text-[9px] text-faint flex-shrink-0">{timeOf(m.ts)}</span>
        )}
      </div>
      <p className="text-xs text-body leading-relaxed whitespace-pre-wrap break-words">{m.content}</p>
    </div>
  );
}

export function BandConversation({
  messages,
  roomId,
  compact = false,
  className = "",
}: {
  messages: BandRoomMessage[];
  roomId?: string | null;
  compact?: boolean;
  className?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-muted">
            Agent conversation · Band
          </h3>
          {roomId && (
            <p className="text-[10px] text-faint mt-0.5 font-mono truncate max-w-[280px]">
              room {roomId.slice(0, 8)}…
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {roomId && (
            <a
              href="https://app.band.ai"
              target="_blank"
              rel="noreferrer"
              className="text-[10px] text-accent hover:underline"
            >
              Open Band ↗
            </a>
          )}
          <span className="text-[10px] text-faint">{messages.length} msgs</span>
        </div>
      </div>
      <div
        className={`space-y-2 overflow-y-auto scrollbar-thin ${
          compact ? "max-h-[320px]" : "max-h-[min(520px,55vh)] min-h-[200px]"
        }`}
      >
        {messages.length === 0 ? (
          <p className="text-xs text-faint py-4 px-1">
            {roomId
              ? "Room open, waiting for agents to @mention each other…"
              : "Connecting Band room. Ensure BAND_API_KEY and local agents are running."}
          </p>
        ) : (
          messages.map((m) => <RoomMessage key={m.id} m={m} />)
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
