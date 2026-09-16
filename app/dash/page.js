// /dash — 작업 현황 대시보드. 읽기 전용이다. 쓰는 쪽은 둘뿐:
// scripts/dash-collect.mjs(10분마다, 기계적 사실) · scripts/dash-say.mjs("여기까지" 시점).
import DashClient from './DashClient';

export const metadata = {
  title: '현황 — Ra_Kan',
  description: '작업·일정·할 일과 놓치고 있던 것을 한 화면에',
};

export default function Page() {
  return <DashClient />;
}
