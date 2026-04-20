import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { ThemeProvider } from "@/lib/theme";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";

import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-display font-semibold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-display text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Handwritten Exam Evaluation" },
      { name: "description", content: "Upload Bangla or English handwritten exam papers, extract structured text, and grade against your rubric — automatically." },
      { property: "og:title", content: "Handwritten Exam Evaluation" },
      { name: "twitter:title", content: "Handwritten Exam Evaluation" },
      { property: "og:description", content: "Upload Bangla or English handwritten exam papers, extract structured text, and grade against your rubric — automatically." },
      { name: "twitter:description", content: "Upload Bangla or English handwritten exam papers, extract structured text, and grade against your rubric — automatically." },
      { property: "og:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/ffzj3b6oMwVnWiaMj5DKB3SGex53/social-images/social-1776716919515-Screenshot_2026-04-21_022824.webp" },
      { name: "twitter:image", content: "https://storage.googleapis.com/gpt-engineer-file-uploads/ffzj3b6oMwVnWiaMj5DKB3SGex53/social-images/social-1776716919515-Screenshot_2026-04-21_022824.webp" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=Noto+Sans+Bengali:wght@400;500;600&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Outlet />
        <Toaster />
      </AuthProvider>
    </ThemeProvider>
  );
}
