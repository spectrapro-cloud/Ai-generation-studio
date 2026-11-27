import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LUMI AI — Create Without Limits",
  description: "A premium workspace for real AI image and video creation.",
  applicationName: "LUMI AI"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
