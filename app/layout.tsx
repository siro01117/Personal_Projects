import type { Metadata, Viewport } from "next";
import { Suspense, type ReactNode } from "react";
import { Ripple } from "./_ui/Ripple";
import { ToastProvider } from "./_ui/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "EZ.WORK",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        {/* 밝기 선택(흑백 토글)을 그리기 전에 적용 — 안 하면 한 번 시스템 색으로 번쩍인다. 기본은 시스템 설정 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('ezwork.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}",
          }}
        />
        {/* 목업과 같은 글꼴 (Pretendard 는 깔려 있으면 먼저 쓴다) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;500;600&family=Poppins:wght@500;600&display=swap"
        />
      </head>
      <body>
        <ToastProvider>
          {/* 화면은 모두 클라이언트에서 그린다 (주소의 ?demo=1 · 로그인 세션을 읽어야 해서) */}
          <Suspense fallback={null}>{children}</Suspense>
          <Ripple />
        </ToastProvider>
      </body>
    </html>
  );
}
