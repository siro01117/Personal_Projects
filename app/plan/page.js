// /plan — 정적으로 굽히는 껍데기 하나. 내용은 전부 클라이언트에서 Supabase 로 가져온다
// (output:'export' 라 서버에서 데이터를 못 읽는다).
import PlanClient from './PlanClient';

export const metadata = {
  title: '일정 — Ra_Kan',
  description: '오늘·7일 타임라인, 특별한 약속, 언젠가 할 일과 옮기기 제안',
};

export default function Page() {
  return <PlanClient />;
}
