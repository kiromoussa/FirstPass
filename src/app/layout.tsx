import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FirstPass — Pre-submission permit readiness",
  description:
    "Upload your residential plans and receive a cited, sheet-by-sheet permit-readiness report before submitting them to the city.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
