// 이 라우트 세그먼트에서만 로드되는 스코프 CSS(.sqdemo 하위로만 적용) — 포털 홈 등 다른 라우트엔 영향 없음.
import "./sqdemo.css";

export const metadata = {
  title: "스터디큐브 라이브 데모",
};

export default function StudyCubeDemoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
