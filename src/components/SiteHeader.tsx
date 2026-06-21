"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { DEMO_VIDEO_URL } from "@/lib/demo-video";

export function SiteHeader() {
  const pathname = usePathname();
  const onDashboard = pathname === "/dashboard";

  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-[rgba(251,252,250,0.82)] backdrop-blur-md">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-10 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <span className="flex h-7 w-7 items-center justify-center rounded-[7px] overflow-hidden">
            <Image
              src="/firstpass-mark.png"
              alt="FirstPass logo"
              width={28}
              height={28}
              priority
              className="h-7 w-7 object-contain"
            />
          </span>
          <span className="font-display font-bold text-xl tracking-tight text-ink">FirstPass</span>
        </Link>

        <div className="flex items-center gap-3.5">
          {onDashboard ? (
            <Link href="/dashboard" className="text-[14.5px] font-semibold text-teal transition-colors">
              Dashboard
            </Link>
          ) : (
            <a
              href={DEMO_VIDEO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[14.5px] font-semibold text-ink hover:text-teal transition-colors"
            >
              Get a demo
            </a>
          )}
          <Link
            href="/dashboard"
            className="text-[14.5px] font-semibold text-white bg-teal rounded-[10px] px-[17px] py-2.5 hover:bg-teal-600 transition-colors"
          >
            Try it free
          </Link>
        </div>
      </div>
    </header>
  );
}
