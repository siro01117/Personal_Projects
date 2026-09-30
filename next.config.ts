import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // next dev 가 CLAUDE.md 에 안내 글을 덧붙이지 않게 (이 저장소의 CLAUDE.md 는 사람이 관리)
  agentRules: false,
  // 상위 폴더(C:\Users\PC)의 package-lock.json 을 작업 폴더로 잘못 잡지 않게
  turbopack: { root: import.meta.dirname },
  async headers() {
    // 공유 페이지는 검색엔진 차단 (메타 태그와 함께 헤더로도)
    return [{ source: "/s/:token", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
