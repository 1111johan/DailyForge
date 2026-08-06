import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DailyForge Lite",
  description: "每日内容生产运行台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
