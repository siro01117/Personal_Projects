import './globals.css';

export const metadata = {
  title: 'Ra_Kan — Personal Projects',
  description: '실험적 개인 프로젝트 포털',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link href="https://api.fontshare.com/v2/css?f[]=clash-display@300,400,500,600&f[]=satoshi@300,400,500,700&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
