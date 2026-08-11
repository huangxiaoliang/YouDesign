import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/lib/theme/ThemeContext";
import { BASE_PATH } from "@/lib/basePath";

export const metadata: Metadata = {
  title: "YouDesign · 高保真原型设计Agent",
  description: "用自然语言把需求变成高保真可交互原型",
  icons: {
    icon: [
      { url: `${BASE_PATH}/favicon-16x16.png`, type: "image/png", sizes: "16x16" },
      { url: `${BASE_PATH}/favicon-32x32.png`, type: "image/png", sizes: "32x32" },
      { url: `${BASE_PATH}/favicon.svg`, type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Oswald:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&family=Geist:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
