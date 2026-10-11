import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Safety Line",
  description:
    "Ask what public safety guidance says about physical and ambient AI. Answers come only from eight public documents, with a citation for every claim.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1113" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        {/* Only the two faces needed for the first paint. See globals.css. */}
        <link rel="preload" href="/fonts/IBMPlexSans-Regular.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/IBMPlexSans-Medium.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="column site-header label">
          <span>Safety Line</span>
          <a href="https://briankerr.design">Brian Kerr</a>
        </header>
        {/* The yellow "safety line". Decorative, so hidden from screen readers. */}
        <div className="column" aria-hidden="true">
          <div className="signal-line" />
        </div>
        <main id="main" className="column" tabIndex={-1}>
          {children}
        </main>
        <footer className="column site-footer meta">
          <span>© 2026 Brian Kerr</span>
        </footer>
      </body>
    </html>
  );
}
