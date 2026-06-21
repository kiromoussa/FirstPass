import { Reveal } from "@/components/Reveal";

type Feature = {
  icon: React.ReactNode;
  title: string;
  body: string;
  dark?: boolean;
};

const stroke = (children: React.ReactNode, color = "#1f8a4c") => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const FEATURES: Feature[] = [
  {
    icon: stroke(<><circle cx="11" cy="11" r="7" /><line x1="16.5" y1="16.5" x2="21" y2="21" /></>),
    title: "Multi-agent code research",
    body: "Agents browse official municipal codes, zoning regulations, and state requirements, with every claim backed by a live, verifiable citation.",
  },
  {
    icon: stroke(<><rect x="4" y="3" width="16" height="18" rx="2" /><line x1="8" y1="8" x2="16" y2="8" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="16" x2="12" y2="16" /></>),
    title: "Sheet-by-sheet plan reading",
    body: "AI vision reads your PDF plan set and extracts setbacks, heights, coverage, and floor area straight from the drawings.",
  },
  {
    icon: stroke(<polyline points="4 12 9 17 20 5" />),
    title: "Deterministic checks",
    body: "Extracted facts are compared against jurisdiction thresholds with fixed rules. Every finding has a source, no guesswork.",
  },
  {
    icon: stroke(<><path d="M21 11.5a8.5 8.5 0 1 1-3.5-6.9" /><polyline points="21 4 21 9 16 9" /></>),
    title: "Agent audit loop",
    body: "A reviewer agent challenges findings, corrects errors, and surfaces disagreements in real time, so the report you get is vetted.",
  },
  {
    icon: stroke(<><polyline points="4 7 7 10 11 5" /><polyline points="4 16 7 19 11 14" /><line x1="14" y1="8" x2="20" y2="8" /><line x1="14" y1="17" x2="20" y2="17" /></>),
    title: "Submission checklist",
    body: "Required documents and forms, sorted: what's present, what's missing, and what to fix first before you submit.",
  },
  {
    icon: stroke(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>, "#54e08a"),
    title: "Readiness report",
    body: "A scored 0 to 100 report with prioritized violations, code sections, and suggested corrections, viewable and exportable.",
    dark: true,
  },
];

export function FeaturesGrid() {
  return (
    <Reveal id="features" className="bg-[#fbfcfa]">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-20">
        <div className="max-w-[620px] mb-12">
          <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">What you get</div>
          <h2 className="font-display font-bold text-[42px] leading-[1.06] tracking-[-0.03em] text-ink m-0">
            Everything a reviewer would check, before a reviewer sees it.
          </h2>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4" style={{ gap: 18 }}>
          {FEATURES.map((f) => (
            <article
              key={f.title}
              className={`rounded-[16px] p-[26px] border transition-all duration-200 hover:-translate-y-1 hover:shadow-card ${
                f.dark ? "bg-[#15170f] border-[#15170f]" : "bg-white border-[#e7e9e2]"
              }`}
            >
              <div
                className="w-[42px] h-[42px] rounded-[11px] flex items-center justify-center mb-[18px]"
                style={{ background: f.dark ? "rgba(84,224,138,0.14)" : "#eef7f0" }}
              >
                {f.icon}
              </div>
              <h3 className={`font-display font-bold text-[19px] mb-2 ${f.dark ? "text-white" : "text-ink"}`}>
                {f.title}
              </h3>
              <p className={`text-[14.5px] leading-[1.5] m-0 ${f.dark ? "text-[#aeb4a6]" : "text-body"}`}>
                {f.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </Reveal>
  );
}
