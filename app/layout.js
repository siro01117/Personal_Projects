import Script from 'next/script';
import './globals.css';

export const metadata = {
  title: 'Ra_Kan — Personal Projects',
  description: '직접 만들어 쓰는 개인 프로젝트 모음',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',            // 노치·홈 인디케이터까지 배경을 깔고 여백은 safe-area 로 잡는다
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f3' },
    { media: '(prefers-color-scheme: dark)', color: '#16171b' },
  ],
};

// 첫 페인트 전에 테마를 확정한다 — 하이드레이션을 기다리면 라이트 모드에서 어두운 화면이 한 번 번쩍인다.
const THEME_INIT = `try{var t=localStorage.getItem('rakan.theme');
if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}
document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}`;

export default function RootLayout({ children }) {
  return (
    <html lang="ko" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
        <Script id="theme-init" strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
