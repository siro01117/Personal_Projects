// /open — 로그인 없이 볼 수 있는 유일한 화면.
//
// 게이트 밖에 있으므로 여기서는 Supabase 도, 개인 데이터도 건드리지 않는다.
// 내용은 public/open/*.html 에 통째로 들어 있는 정적 시안뿐이고, 이 페이지는 그 목록과
// 액자 역할만 한다. 포털의 다른 화면과 코드를 공유하지 않는 것이 의도다 —
// 공유하는 순간 게이트 안쪽 모듈이 딸려 나올 위험이 생긴다.
import OpenClient from './OpenClient';

export const metadata = {
  title: '둘러보기 — Ra_Kan',
  description: '로그인 없이 볼 수 있는 시안 모음',
};

export default function Page() {
  return <OpenClient />;
}
