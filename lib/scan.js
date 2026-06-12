// 프로젝트 자동 스캔 — public/projects/<id>/ 폴더를 읽어 목록 생성.
// 새 프로젝트 = 폴더 하나 추가 + manifest.json → push → 자동 등록.
// (포털 로직 코드는 안 건드림)
import fs from 'node:fs';
import path from 'node:path';

export function scanProjects() {
  const dir = path.join(process.cwd(), 'public', 'projects');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))   // _로 시작하는 폴더는 제외(견본 등)
    .map((e) => {
      const base = path.join(dir, e.name);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf-8')); } catch {}
      const hasIndex = fs.existsSync(path.join(base, 'index.html'));
      return {
        id: e.name,
        name: meta.name || e.name,
        desc: meta.desc || '',
        stack: Array.isArray(meta.stack) ? meta.stack : [],
        public: meta.public !== false,           // 기본 공개, manifest에서 false면 비공개
        order: typeof meta.order === 'number' ? meta.order : 99,
        embedUrl: meta.embedUrl || (hasIndex ? `/projects/${e.name}/index.html` : ''),
      };
    })
    .sort((a, b) => a.order - b.order);
}
