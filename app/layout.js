import './globals.css';

export const metadata = {
  title: 'Ra_Kan — Personal Projects',
  description: '직접 만들어 쓰는 개인 프로젝트 색인',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0b0d',
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <head>
        {/* Zodiak = 라틴·숫자 전용 표시체(워드마크·섹션 라벨). 한글 본문은 Pretendard 고정 —
            한글이 세리프로 튀지 않도록 --disp 는 라틴이 나오는 자리에만 쓴다. */}
        <link rel="preconnect" href="https://api.fontshare.com" crossOrigin="" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="" />
        <link href="https://api.fontshare.com/v2/css?f[]=zodiak@400,500&display=swap" rel="stylesheet" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
      </head>
      <body>{children}</body>
    </html>
  );
}
