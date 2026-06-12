// 서버 컴포넌트 — projects 폴더를 스캔해서 클라이언트로 전달.
// 새 프로젝트 폴더를 추가하면 여기 코드 수정 없이 자동 반영.
import { scanProjects } from '../lib/scan';
import PortalClient from './PortalClient';

// 정적 추출 — 빌드 시점에 scanProjects() 실행해 프로젝트 목록을 정적으로 굽는다.
export default function Page() {
  const projects = scanProjects();
  return <PortalClient projects={projects} />;
}
