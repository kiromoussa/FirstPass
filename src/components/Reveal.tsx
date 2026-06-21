"use client";

import { useEffect, useRef, useState } from "react";

// Fades a section up into place the first time it scrolls into view, matching
// the design's [data-reveal] IntersectionObserver behavior.
export function Reveal({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!("IntersectionObserver" in window)) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setShown(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1 }
    );
    io.observe(el);
    const fallback = setTimeout(() => setShown(true), 3000);
    return () => {
      io.disconnect();
      clearTimeout(fallback);
    };
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : "translateY(24px)",
        transition: "opacity .7s ease, transform .7s ease",
      }}
    >
      {children}
    </div>
  );
}

// Small logo lockup: the green rounded mark used in the nav and footer.
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.29,
        background: "#1f8a4c",
        position: "relative",
        display: "inline-block",
        flex: "none",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: size * 0.25,
          border: `2.5px solid #fbfcfa`,
          borderRadius: "50%",
          borderBottomColor: "transparent",
          transform: "rotate(45deg)",
        }}
      />
    </span>
  );
}
