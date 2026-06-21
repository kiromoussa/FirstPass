"use client";

import { SPONSOR_META } from "@/lib/ui";
import type { Sponsor } from "@/lib/types";

const ORDER: Sponsor[] = ["claude", "browserbase", "redis", "arize", "band"];

// Lights up the sponsor that most recently produced activity.
export function SponsorRail({ active }: { active?: Sponsor }) {
  return (
    <div className="flex items-center gap-1.5">
      {ORDER.map((s) => {
        const meta = SPONSOR_META[s];
        const on = active === s;
        return (
          <span
            key={s}
            className={`text-[10px] px-2 py-1 rounded-full border transition-all ${on ? "pulse" : ""}`}
            style={{
              color: on ? "#0a0e14" : meta.color,
              background: on ? meta.color : "transparent",
              borderColor: meta.color,
              opacity: on ? 1 : 0.55,
            }}
          >
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}
