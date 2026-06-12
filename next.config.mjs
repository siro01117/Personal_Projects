/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel 서버 함수에서 public/projects 폴더 fs 스캔 가능하게 포함
  outputFileTracingIncludes: {
    '/': ['./public/projects/**/*'],
  },
};
export default nextConfig;
