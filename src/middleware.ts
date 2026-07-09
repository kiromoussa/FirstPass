import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The marketing landing page stays public; everything that touches project
// data (dashboard, project pages, and their APIs) requires a signed-in
// account. /api/agents/compare-codes/run is called by the local Python Band
// agents (server-to-server, no browser session) and must stay reachable.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/agents/compare-codes/run",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/:path*",
  ],
};
