/** @type {import('next').NextConfig} */
const nextConfig = {
  // 정적 추출 — out/ 폴더에 순수 정적 파일 생성 (서버 함수 X).
  // 폴더 스캔(lib/scan.js)은 빌드 시점에 실행 → push마다 재빌드되며 신규 프로젝트 반영.
  output: 'export',
  images: { unoptimized: true },
};
export default nextConfig;
