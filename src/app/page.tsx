import { SiteHeader } from "@/components/SiteHeader";
import { LandingHero } from "@/components/LandingHero";
import { FeaturesGrid } from "@/components/FeaturesGrid";
import {
  PoweredBy,
  TheReality,
  TheCost,
  TheStack,
  ChecksBand,
  LandingCTA,
  LandingFooter,
} from "@/components/LandingSections";

export default function Home() {
  return (
    <div className="min-h-screen bg-[#fbfcfa] text-ink overflow-x-hidden">
      <SiteHeader />
      <LandingHero />
      <PoweredBy />
      <TheReality />
      <TheCost />
      {/* "Not nine prompts in a trenchcoat" sits before "What you get" */}
      <TheStack />
      <FeaturesGrid />
      <ChecksBand />
      <LandingCTA />
      <LandingFooter />
    </div>
  );
}
