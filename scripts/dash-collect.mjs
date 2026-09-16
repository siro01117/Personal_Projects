// 대시보드 수집기 — 로컬에서만 돈다(작업 스케줄러 10분). 기계가 읽을 수 있는 사실만 긁어
// Supabase kv `dash.snapshot` 에 올린다. 판단·해석은 하지 않는다. "놓친 것" 규칙은
// lib/dash-rules.js 가 화면에서 계산한다 — 규칙을 고쳐도 수집기를 다시 돌릴 필요가 없게.
//
//   node scripts/dash-collect.mjs [--dry]
//
// 필요한 것: .env.local 에 SUPABASE_SERVICE_ROLE_KEY (gitignore 됨. 절대 커밋 금지)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const REPOS = (process.env.DASH_REPOS || [
  path.join(HOME, 'Documents/GitHub/Personal_Projects'),
  path.join(HOME, 'Documents/GitHub/Studycube_info'),
  path.join(HOME, 'Documents/GitHub/studycube.cloud'),
].join(path.delimiter)).split(path.delimiter).filter(Boolean);
const VAULT = process.env.DASH_VAULT || path.join(HOME, 'Documents/Obsidian Vault');
const SNAPSHOT_KEY = 'dash.snapshot';

const SEP = ''; // git --format 구분자. 커밋 메시지에 안 나오는 문자여야 한다

/* ------------------------------------------------------------------ 공통 */

const git = (cwd, args) => {
  try {
    // 뒤쪽 개행만 턴다. trim() 을 쓰면 `git status --porcelain` 첫 줄의 앞 칸(" M path")
    // 공백까지 먹어서 경로가 한 글자 잘린다.
    // core.quotepath=false 는 한글 경로가 \xxx 8진 이스케이프로 나오는 걸 막는다.
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args],
      { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true }).replace(/\s+$/, '');
  } catch {
    return null; // 레포가 없거나 origin 이 없을 때 — 전체를 실패시키지 않는다
  }
};
const lines = (s) => (s ? s.split('\n').filter(Boolean) : []);

/* -------------------------------------------------------------- 깃 레포 */

function readRepo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const name = path.basename(dir);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

  // 원격 추적이 없는 브랜치면 ahead/behind 가 안 나온다 — null 로 두고 화면에서 구분
  let ahead = null, behind = null, unpushed = [];
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  if (upstream) {
    const counts = git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    if (counts) {
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b; ahead = a;
    }
    unpushed = lines(git(dir, ['log', `${upstream}..HEAD`, `--format=%h${SEP}%s${SEP}%cI`]))
      .map((l) => { const [sha, subject, at] = l.split(SEP); return { sha, subject, at }; });
  }

  // --porcelain 은 추적/미추적을 한 번에 준다. 파일명은 앞 20개만(스냅샷을 가볍게)
  const dirty = lines(git(dir, ['status', '--porcelain']));
  const last = git(dir, ['log', '-1', `--format=%h${SEP}%s${SEP}%cI`]);
  const [sha, subject, at] = last ? last.split(SEP) : [];

  return {
    name, path: dir, branch, upstream: upstream || null,
    ahead, behind, unpushed,
    dirty: { n: dirty.length, files: dirty.slice(0, 20).map((l) => l.slice(3)) },
    lastCommit: last ? { sha, subject, at } : null,
  };
}

/* ------------------------------------------------------------ 옵시디언 */

// 볼트는 git 이 아니라 파일 수정시각이 유일한 나이 기준이다.
// 미결 표기가 노트마다 제각각이라(미결·할 일·남은 것·다음 단계·TODO) 넓게 잡는다.
// 끝을 \b 로 막으면 안 된다 — JS 의 \w 에 한글이 없어서 `## 미결` 줄 끝이 경계로 안 잡힌다.
// 대신 "뒤에 글자가 더 붙지 않을 것"으로 막는다(미결 O, 미결정 X).
const OPEN_HEADING = /^#{2,4}\s*(미결|할\s*일|남은\s*것|남은\s*과제|다음(\s*단계)?|TODO)(?![가-힣A-Za-z])/i;
const BULLET = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.+?)\s*$/;
const SKIP_DIR = new Set(['.obsidian', '.trash', '.git', 'node_modules', 'raw']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.md')) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function readVault() {
  if (!fs.existsSync(VAULT)) return { ok: false, path: VAULT, openItems: [], daily: null, notes: 0 };
  const files = walk(VAULT);
  const openItems = [];
  let daily = null;

  for (const file of files) {
    const rel = path.relative(VAULT, file).replace(/\\/g, '/');
    let text, mtime;
    try {
      text = fs.readFileSync(file, 'utf8');
      mtime = fs.statSync(file).mtime.toISOString();
    } catch { continue; }

    const m = rel.match(/^데일리\/(\d{4}-\d{2}-\d{2})\.md$/);
    if (m && (!daily || m[1] > daily.date)) daily = { date: m[1], note: rel, mtime };

    // 헤딩 아래 최상위 불릿만 — 하위 불릿까지 올리면 스냅샷이 커지고 화면이 시끄러워진다
    let heading = null;
    for (const raw of text.split('\n')) {
      if (/^#{1,6}\s/.test(raw)) { heading = OPEN_HEADING.test(raw) ? raw.replace(/^#+\s*/, '') : null; continue; }
      if (!heading) continue;
      if (/^\s{2,}[-*]/.test(raw)) continue;
      const b = raw.match(BULLET);
      if (!b) continue;
      openItems.push({
        note: path.basename(rel, '.md'), path: rel, heading,
        text: b[2].replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1').slice(0, 160),
        done: b[1] ? b[1].toLowerCase() === 'x' : false,
        mtime,
      });
    }
  }
  openItems.sort((a, b) => (a.mtime < b.mtime ? -1 : 1)); // 오래 방치된 것부터
  return { ok: true, path: VAULT, openItems, daily, notes: files.length };
}

/* ------------------------------------------------------------------ 실행 */

function loadEnvLocal() {
  const f = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadEnvLocal();
  const snapshot = {
    at: new Date().toISOString(),
    host: process.env.COMPUTERNAME || null,
    repos: REPOS.map(readRepo).filter(Boolean),
    vault: readVault(),
  };

  // 올리지 않고 원본을 그대로 내보낸다 — 키가 없을 때 다른 경로로 넣거나 디버깅할 때 쓴다
  if (process.argv.includes('--json')) {
    const i = process.argv.indexOf('--trim');
    if (i >= 0) {
      const n = Number(process.argv[i + 1]) || 15;
      snapshot.vault.openItems = snapshot.vault.openItems.filter((x) => !x.done).slice(0, n)
        .map((x) => ({ ...x, text: x.text.slice(0, 70) }));
    }
    console.log(JSON.stringify(snapshot));
    return;
  }

  if (process.argv.includes('--dry')) {
    const v = snapshot.vault;
    console.log(`수집 ${snapshot.at}`);
    for (const r of snapshot.repos) {
      console.log(`  ${r.name}: ${r.branch} · 미푸시 ${r.ahead ?? '?'} · dirty ${r.dirty.n} · 마지막 ${r.lastCommit?.at?.slice(0, 10)}`);
    }
    console.log(`  볼트: 노트 ${v.notes} · 미결 ${v.openItems.filter((i) => !i.done).length} · 최신 데일리 ${v.daily?.date}`);
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ovnabmmofgujgefuamzn.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    console.error('SUPABASE_SERVICE_ROLE_KEY 없음 — .env.local 에 넣어주세요 (--dry 로 내용만 볼 수 있습니다)');
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { error } = await sb.from('kv')
    .upsert({ k: SNAPSHOT_KEY, v: snapshot, updated_at: snapshot.at }, { onConflict: 'k' });
  if (error) { console.error('업로드 실패:', error.message); process.exit(1); }
  console.log(`올림 ${snapshot.at} — 레포 ${snapshot.repos.length} · 미결 ${snapshot.vault.openItems.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
