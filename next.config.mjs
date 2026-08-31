/** @type {import('next').NextConfig} */
const nextConfig = {
  // 정적 추출 — out/ 폴더에 순수 정적 파일 생성 (서버 함수 X).
  // 폴더 스캔(lib/scan.js)은 빌드 시점에 실행 → push마다 재빌드되며 신규 프로젝트 반영.
  output: 'export',
  images: { unoptimized: true },
  turbopack: { root: import.meta.dirname },
  // build 스크립트는 --webpack 고정. Turbopack 프로덕션 빌드는 PGlite(@electric-sql/pglite)의
  // 네임스페이스 export 를 잘라내 런타임에 "instantiateWasm is not a function" 으로 죽는다
  // (dev 는 트리셰이킹을 안 해 통과 → 배포에서만 재현). 데모 DB 가 PGlite 라 이 제약이 걸린다.
};
export default nextConfig;
