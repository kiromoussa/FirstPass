import Image from "next/image";
import Link from "next/link";
import { Reveal, BrandMark } from "@/components/Reveal";
import { DEMO_VIDEO_EMBED, DEMO_VIDEO_URL } from "@/lib/demo-video";

/* ===== DEMO VIDEO ===== */
export function DemoVideo() {
  return (
    <Reveal id="demo" className="border-b border-hairline bg-[#fbfcfa]">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-16 lg:py-20">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-10 lg:gap-14 items-center">
          <div>
            <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">
              Demo video
            </div>
            <h2 className="font-display font-bold text-[36px] sm:text-[42px] leading-[1.06] tracking-[-0.03em] text-ink mb-4">
              See FirstPass run end to end.
            </h2>
            <p className="text-[17px] leading-[1.55] text-body mb-6 max-w-[440px]">
              Watch the full hackathon walkthrough: live code research, plan reading,
              compliance checks, the auditor correction, and the cited readiness report.
            </p>
            <a
              href={DEMO_VIDEO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-[15px] font-semibold text-teal hover:text-teal-600 transition-colors"
            >
              Open on YouTube
              <span aria-hidden>↗</span>
            </a>
          </div>
          <div
            className="relative w-full aspect-video rounded-[16px] overflow-hidden border border-[#e7e9e2] bg-[#15170f]"
            style={{ boxShadow: "0 20px 50px -28px rgba(20,40,25,0.35)" }}
          >
            <iframe
              src={DEMO_VIDEO_EMBED}
              title="FirstPass demo video"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="absolute inset-0 h-full w-full border-0"
            />
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* ===== POWERED BY ===== */
export function PoweredBy() {
  return (
    <Reveal className="border-t border-b border-hairline bg-[#fbfcfa]">
      <div className="max-w-[1100px] mx-auto px-6 lg:px-10 py-[30px] flex items-center justify-center gap-x-12 gap-y-5 flex-wrap">
        <span className="font-mono text-[11px] tracking-[0.16em] uppercase text-faint">Powered by</span>
        <div className="flex items-center gap-2.5">
          <Image src="/logos/browserbase.png" alt="Browserbase" width={26} height={26} className="h-[26px] w-[26px] rounded-md object-contain" />
          <span className="text-[17px] font-semibold text-[#3f433a]">Browserbase</span>
        </div>
        <Image src="/logos/band.png" alt="Band" width={96} height={26} className="h-[26px] w-auto object-contain" />
        <div className="flex items-center gap-2.5">
          <Image src="/logos/redis.png" alt="Redis" width={26} height={26} className="h-[26px] w-[26px] rounded-md object-contain" />
          <span className="text-[17px] font-semibold text-[#3f433a]">Redis</span>
        </div>
        <Image src="/logos/arize.png" alt="Arize" width={91} height={24} className="h-6 w-auto object-contain" />
        <Image src="/logos/claude.png" alt="Claude" width={116} height={25} className="h-[25px] w-auto object-contain" />
      </div>
    </Reveal>
  );
}

/* ===== THE REALITY ===== */
const STATS = [
  {
    big: "90+",
    bigColor: "#1f8a4c",
    unit: "days · median permit review",
    head: "It takes months",
    body: "The median building permit runs about 90 days before corrections even begin. Miami averages 315; San Francisco's 90th percentile nears two years.",
  },
  {
    big: "741",
    bigColor: "#1f8a4c",
    unit: "cities · no single rulebook",
    head: "The code is inaccessible",
    body: "Rules live across municipal sites, state amendments, and restrictive portals: technically public, but unusable without a compliance team to navigate them.",
  },
  {
    big: "~60%",
    bigColor: "#c2410c",
    unit: "rejected on first submission",
    head: "It's a loop by design",
    body: "Most permit submissions don't pass the first try. Each correction letter costs 2 to 8 weeks while financing accrues and schedules slip.",
  },
];

export function TheReality() {
  return (
    <Reveal id="problem" className="bg-[#fbfcfa] border-b border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-20">
        <div className="max-w-[680px] mb-11">
          <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">The reality</div>
          <h2 className="font-display font-bold text-[42px] leading-[1.06] tracking-[-0.03em] text-ink mb-4">
            City code approval wasn&apos;t built for a clean first pass.
          </h2>
          <p className="text-[17.5px] leading-[1.55] text-body">
            Every architect, contractor, and homeowner hits the same wall: a
            process that drags on for months, buries the rules in broken portals,
            and sends most plans back for corrections. These aren&apos;t edge
            cases. They&apos;re the norm.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-4.5" style={{ gap: 18 }}>
          {STATS.map((s) => (
            <div key={s.head} className="bg-white border border-[#e7e9e2] rounded-[16px] p-[30px]">
              <div className="font-display font-bold text-[54px] leading-none tracking-[-0.03em]" style={{ color: s.bigColor }}>
                {s.big}
              </div>
              <div className="font-mono text-[11px] tracking-[0.1em] uppercase text-faint mt-2.5 mb-3.5">{s.unit}</div>
              <div className="text-[16px] font-semibold mb-1.5 text-ink">{s.head}</div>
              <p className="text-[13.5px] leading-[1.5] text-body m-0">{s.body}</p>
            </div>
          ))}
        </div>
        <p className="font-mono text-[11px] text-[#b0b4a8] mt-5.5" style={{ marginTop: 22 }}>
          Sources: Shovels Permit Index 2025 · PermitPlace State of Building Permits 2026 · municipal permit-flow analysis.
        </p>
      </div>
    </Reveal>
  );
}

/* ===== THE COST ===== */
const COST = [
  {
    big: "95%",
    bigColor: "#c2410c",
    unit: "permit apps require rework",
    head: "Almost nothing passes clean",
    body: "Deloitte found 95% of permit applications need rework for incomplete or missing information at submission. Rejection is the default, not the exception.",
  },
  {
    big: "$805",
    bigColor: "#1f8a4c",
    unit: "average cost per rejected submittal",
    head: "Every bounce has a price",
    body: "A survey of 6,000+ construction professionals pegged the direct cost of a single rejected submittal at $805, before counting the weeks of schedule slip behind it.",
  },
  {
    big: "$60B",
    bigColor: "#1f8a4c",
    unit: "in development stalled each year",
    head: "Red tape, at national scale",
    body: "Nearly $60 billion in economic development is delayed annually by red tape in local approval processes. The cost of the loop compounds far past any one project.",
  },
];

export function TheCost() {
  return (
    <Reveal id="cost" className="bg-white border-b border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-20">
        <div className="max-w-[680px] mb-11">
          <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">The cost</div>
          <h2 className="font-display font-bold text-[42px] leading-[1.06] tracking-[-0.03em] text-ink mb-4">
            Getting it wrong isn&apos;t cheap.
          </h2>
          <p className="text-[17.5px] leading-[1.55] text-body">
            A failed first pass doesn&apos;t just cost time. It burns billable
            hours, revision fees, and financing, on a process where rework is the
            baseline. FirstPass exists to break that pattern before submission.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-4.5" style={{ gap: 18 }}>
          {COST.map((s) => (
            <div key={s.head} className="bg-[#fbfcfa] border border-[#e7e9e2] rounded-[16px] p-[30px]">
              <div className="font-display font-bold text-[54px] leading-none tracking-[-0.03em]" style={{ color: s.bigColor }}>
                {s.big}
              </div>
              <div className="font-mono text-[11px] tracking-[0.1em] uppercase text-faint mt-2.5 mb-3.5">{s.unit}</div>
              <div className="text-[16px] font-semibold mb-1.5 text-ink">{s.head}</div>
              <p className="text-[13.5px] leading-[1.5] text-body m-0">{s.body}</p>
            </div>
          ))}
        </div>
        <p className="font-mono text-[11px] text-[#b0b4a8] mt-5.5" style={{ marginTop: 22 }}>
          Sources: Deloitte permit-rework analysis · BuildSync survey of 6,000+ construction professionals · Red Tape Index 2025.
        </p>
      </div>
    </Reveal>
  );
}

/* ===== THE STACK ===== */
type StackCard = {
  logo?: string;
  logoH?: number;
  name?: string;
  svg?: React.ReactNode;
  tag: string;
  tagDark?: boolean;
  body: string;
};

const STACK: StackCard[] = [
  {
    logo: "/logos/band.png",
    logoH: 22,
    tag: "CORE",
    body: "Orchestrates every agent handoff in one shared chat room, the firm's nervous system. Agents @mention each other and retry when something's missing.",
  },
  {
    logo: "/logos/browserbase.png",
    logoH: 24,
    name: "Browserbase",
    tag: "CORE",
    body: "Drives live sessions against real .gov planning and building sites, so every citation comes back with a source URL and excerpt, not a guess.",
  },
  {
    logo: "/logos/redis.png",
    logoH: 24,
    name: "Redis",
    tag: "CORE",
    body: "Holds project state, the agent blackboard, and the chunked code corpus, including vector search to retrieve the section that applies to each fact.",
  },
  {
    logo: "/logos/claude.png",
    logoH: 22,
    tag: "VISION",
    tagDark: true,
    body: "Reads the plan set with vision, extracts each dimension with its sheet reference, and writes the report prose, never the pass/fail number.",
  },
  {
    logo: "/logos/arize.png",
    logoH: 20,
    tag: "EVALS",
    tagDark: true,
    body: "Tracing and evals across every run. The applicability eval is what flips a scripted FAIL to PASS when a rule doesn't actually apply.",
  },
  {
    svg: (
      <svg width="24" height="24" viewBox="0 0 24 24">
        <path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z" fill="none" stroke="#0696D7" strokeWidth="2" strokeLinejoin="round" />
        <path d="M12 3 L12 12 M12 12 L20 7.5 M12 12 L4 7.5" fill="none" stroke="#0696D7" strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
    name: "Autodesk APS",
    tag: "OPTIONAL",
    tagDark: true,
    body: "Optional DWG/DXF upload, cloud plotting, and in-browser plan viewing for teams working straight from CAD files.",
  },
];

export function TheStack() {
  return (
    <Reveal id="stack" className="bg-[#fbfcfa] border-t border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-20">
        <div className="max-w-[680px] mb-11">
          <div className="font-mono text-[12px] tracking-[0.14em] uppercase text-teal mb-3.5">The stack</div>
          <h2 className="font-display font-bold text-[42px] leading-[1.06] tracking-[-0.03em] text-ink mb-4">
            Not nine prompts in a trenchcoat.
          </h2>
          <p className="text-[17.5px] leading-[1.55] text-body">
            Every agent in the pipeline is a real, separate process. Here&apos;s
            what&apos;s actually doing the work underneath.
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4" style={{ gap: 16 }}>
          {STACK.map((c, i) => (
            <div
              key={i}
              className="bg-white border border-[#e7e9e2] rounded-[16px] p-6 transition-transform duration-200 hover:-translate-y-[3px] hover:shadow-card"
            >
              <div className="flex items-center gap-2.5 mb-3">
                {c.logo ? (
                  <Image src={c.logo} alt={c.name ?? ""} width={120} height={c.logoH ?? 22} className="w-auto object-contain" style={{ height: c.logoH ?? 22 }} />
                ) : (
                  c.svg
                )}
                {c.name && <span className="font-display font-bold text-[17px] text-ink">{c.name}</span>}
                <span
                  className={`ml-auto font-mono text-[10px] tracking-[0.08em] rounded-[5px] px-1.5 py-1 ${
                    c.tagDark ? "text-muted bg-[#f2f3ef]" : "text-teal bg-[#eef7f0]"
                  }`}
                >
                  {c.tag}
                </span>
              </div>
              <p className="text-[14px] leading-[1.5] text-body m-0">{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* ===== COMPLIANCE CHECKS BAND ===== */
const CHECKS = [
  { n: "01", title: "Floor area & size", detail: "Building area vs. jurisdiction limits" },
  { n: "02", title: "Height limit", detail: "Building height vs. jurisdiction maximum" },
  { n: "03", title: "Setbacks", detail: "Rear & side setbacks vs. minimums" },
  { n: "04", title: "Required documents", detail: "Site plan, floor plan, elevations present" },
];

export function ChecksBand() {
  return (
    <Reveal className="bg-white border-t border-b border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-14">
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-7">
          <h2 className="font-display font-bold text-[28px] tracking-[-0.02em] text-ink m-0">
            Checks run on every plan set
          </h2>
          <span className="font-mono text-[12px] text-muted">Residential, commercial & renovation · expanding by jurisdiction</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          {CHECKS.map((c) => (
            <div key={c.n} className="border border-[#e7e9e2] rounded-[14px] p-5">
              <div className="font-mono text-[11px] text-teal tracking-[0.06em] mb-2.5">{c.n}</div>
              <div className="text-[16px] font-semibold mb-1 text-ink">{c.title}</div>
              <div className="text-[13px] text-muted">{c.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </Reveal>
  );
}

/* ===== CTA ===== */
export function LandingCTA() {
  return (
    <Reveal className="bg-[#fbfcfa] px-6 lg:px-10 py-[72px]">
      <div className="max-w-[1000px] mx-auto relative bg-[#0e1410] rounded-[24px] px-8 sm:px-14 py-16 overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(rgba(84,224,138,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(84,224,138,0.06) 1px,transparent 1px)",
            backgroundSize: "40px 40px",
            WebkitMaskImage: "radial-gradient(ellipse 70% 100% at 80% 0%,#000 30%,transparent 75%)",
            maskImage: "radial-gradient(ellipse 70% 100% at 80% 0%,#000 30%,transparent 75%)",
          }}
        />
        <div className="relative max-w-[560px]">
          <h2 className="font-display font-bold text-[36px] sm:text-[44px] leading-[1.04] tracking-[-0.03em] text-white mb-4">
            Stop the resubmission loop. Pass the first time.
          </h2>
          <p className="text-[18px] leading-[1.55] text-[#aeb4a6] mb-7.5" style={{ marginBottom: 30 }}>
            Every violation caught, every fix proposed, every source cited,
            before the city ever sees your file.
          </p>
          <div className="flex items-center gap-2 bg-[#161e16] border border-[rgba(255,255,255,0.12)] rounded-[14px] p-[7px] pl-[18px] max-w-[480px]">
            <span className="flex-1 text-[15px] text-[#8b9184] truncate">1216 E 92nd St, Los Angeles, CA…</span>
            <Link
              href="/dashboard"
              className="text-[15px] font-semibold text-[#0e1410] bg-[#54e08a] rounded-[10px] px-5 py-2.5 hover:-translate-y-0.5 transition-transform"
            >
              Start a project
            </Link>
          </div>
        </div>
      </div>
    </Reveal>
  );
}

/* ===== FOOTER ===== */
export function LandingFooter() {
  return (
    <footer className="bg-[#fbfcfa] border-t border-hairline">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-12 flex items-start justify-between flex-wrap gap-8">
        <div className="max-w-[300px]">
          <div className="flex items-center gap-2.5 mb-3">
            <BrandMark size={22} />
            <span className="font-display font-bold text-[18px] text-ink">FirstPass</span>
          </div>
          <p className="text-[13.5px] leading-[1.5] text-muted m-0">
            FirstPass flags likely issues for review before submission. It is not
            an official permit review, a code certification, or a substitute for a
            licensed architect, engineer, or your local building department.
          </p>
        </div>
        <div className="flex gap-x-16 gap-y-8 flex-wrap">
          <FooterCol title="Product" items={["How it works", "Features", "Pricing"]} />
          <FooterCol title="Company" items={["About", "Careers", "Contact"]} />
          <FooterCol title="Resources" items={["Sample report", "Supported codes", "Docs"]} />
        </div>
      </div>
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 pt-5 pb-9 border-t border-hairline flex items-center justify-between flex-wrap gap-2.5">
        <span className="text-[13px] text-faint">
          © 2026 FirstPass · Built by Kiro Moussa, Varun Sanjeev, David Pelazini &amp; Krishiv Bhatia · UC Berkeley AI Hackathon 2026
        </span>
        <span className="text-[13px] text-faint">Privacy · Terms</span>
      </div>
    </footer>
  );
}

function FooterCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="font-mono text-[11px] tracking-[0.1em] uppercase text-faint mb-3.5">{title}</div>
      <div className="flex flex-col gap-2.5 text-[14px] text-[#3f433a]">
        {items.map((i) => (
          <span key={i} className="cursor-pointer hover:text-teal transition-colors">{i}</span>
        ))}
      </div>
    </div>
  );
}
