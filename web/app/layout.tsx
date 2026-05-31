/// Root layout for PrivateTip — Server Component.
///
/// Metadata belongs in the server component. FlowProvider and other
/// client-side providers are wrapped in a separate client component.

import type { Metadata } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import ClientLayout from "./client-layout";
import "./globals.css";

// Display / headings — classical serif with roman temple character
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  weight: "variable",
  display: "swap",
});

// Body / UI — matches Flow brand
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

// Mono — hex, addresses, code
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const SITE_DESCRIPTION =
  "Send FLOW with cryptographically hidden amounts using Pedersen commitments and Groth16 proofs on Flow EVM testnet. Privacy, not anonymity. Audit in progress.";

export const metadata: Metadata = {
  title: "PrivateTip — Confidential Tipping on Flow",
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "PrivateTip — Confidential tipping on Flow",
    description: SITE_DESCRIPTION,
    type: "website",
    images: ["/og-image.png"],
  },
  twitter: {
    card: "summary_large_image",
    title: "PrivateTip — Confidential tipping on Flow",
    description: SITE_DESCRIPTION,
    images: ["/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ClientLayout>{children}</ClientLayout>
      </body>
    </html>
  );
}
