// 서버 컴포넌트 — projects 폴더를 스캔해서 클라이언트로 전달.
// 새 프로젝트 폴더를 추가하면 여기 코드 수정 없이 자동 반영.
import { scanProjects } from '../lib/scan';
import PortalClient from './PortalClient';

export const dynamic = 'force-dynamic';

export default function Page() {
  const projects = scanProjects();
  return <PortalClient projects={projects} />;
}
