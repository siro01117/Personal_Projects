// /study — 정적으로 굽히는 껍데기 하나. 내용은 전부 클라이언트에서 Supabase 로 가져온다
// (output:'export' 라 서버에서 데이터를 못 읽는다). 과목 구분은 쿼리스트링(?c=)이다.
import StudyClient from './StudyClient';

export const metadata = {
  title: '학습 — Ra_Kan',
  description: '학기 대시보드 · 과목 상세 · 시험대비',
};

export default function Page() {
  return <StudyClient />;
}
