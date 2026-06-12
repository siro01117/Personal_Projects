/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel 서버 함수에서 public/projects 폴더 fs 스캔 가능하게 포함
  // Next 14에선 experimental 하위 키 (Next 15부터 top-level로 승격)
  experimental: {
    outputFileTracingIncludes: {
      '/': ['./public/projects/**/*'],
    },
  },
};
export default nextConfig;
