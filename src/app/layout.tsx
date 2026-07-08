import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CineMM Scraper - Search & Download Movie/Series Data as JSON",
  description:
    "Personal-use search and JSON exporter for cinemm.com. Search movies & TV series with Myanmar subtitles, view full post details, and download as JSON.",
  keywords: ["cinemm", "movie search", "series search", "Myanmar subtitles", "JSON downloader"],
  authors: [{ name: "Personal Use" }],
  openGraph: {
    title: "CineMM Scraper",
    description: "Search cinemm.com and download post data as JSON",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
