// 세션 상태 기록기 — 에이전트(또는 사람)가 "일단 여기까지" 시점에 한 번 부른다.
// 대시보드 세 층 중 유일하게 토큰이 드는 층이라, 호출 한 번에 끝나도록 만들었다.
//
//   node scripts/dash-say.mjs --id plan --title "일정 모듈" --status active \
//        --note "여백·정렬 정리 끝" --next "scorer 기준" --awaiting "이동시간 기준" --repo Personal_Projects
//   node scripts/dash-say.mjs --id plan --status done
//   node scripts/dash-say.mjs --list
//
// --id 는 작업 축의 고유 이름이다. 같은 id 로 다시 부르면 덮어쓴다(누적 X) — 병렬 세션이
// 각자 다른 id 를 쓰면 서로 안 섞인다. 준 필드만 갱신하고 안 준 필드는 유지한다.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const SESSIONS_KEY = 'dash.sessions';
const FIELDS = ['title', 'status', 'note', 'blocked', 'awaiting', 'repo'];

function parseArgs(argv) {
  const out = { next: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'list' || k === 'dry') { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { out[k] = ''; continue; }
    if (k === 'next') out.next.push(v); else out[k] = v;
    i += 1;
  }
  return out;
}

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
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ovnabmmofgujgefuamzn.supabase.co';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) { console.error('SUPABASE_SERVICE_ROLE_KEY 없음 — .env.local 확인'); process.exit(1); }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data, error } = await sb.from('kv').select('v').eq('k', SESSIONS_KEY).maybeSingle();
  if (error) { console.error('읽기 실패:', error.message); process.exit(1); }
  const list = Array.isArray(data?.v?.list) ? data.v.list : [];

  if (args.list) {
    for (const s of list) console.log(`${s.status === 'done' ? '✓' : '·'} ${s.id}  ${s.title}  (${s.at?.slice(0, 16)})`);
    if (!list.length) console.log('기록된 세션 없음');
    return;
  }
  if (!args.id) { console.error('--id 필요 (작업 축 이름). --list 로 기존 목록 확인'); process.exit(1); }

  const at = new Date().toISOString();
  const i = list.findIndex((s) => s.id === args.id);
  const prev = i >= 0 ? list[i] : { id: args.id, status: 'active', next: [] };
  const merged = { ...prev, at };
  for (const f of FIELDS) if (args[f] !== undefined) merged[f] = args[f];
  if (args.next.length) merged.next = args.next;
  if (!merged.title) { console.error('새 항목이면 --title 이 필요합니다'); process.exit(1); }

  if (i >= 0) list[i] = merged; else list.push(merged);

  if (args.dry) { console.log(JSON.stringify(merged, null, 2)); return; }

  const up = await sb.from('kv')
    .upsert({ k: SESSIONS_KEY, v: { list }, updated_at: at }, { onConflict: 'k' });
  if (up.error) { console.error('쓰기 실패:', up.error.message); process.exit(1); }
  console.log(`기록 ${merged.id} · ${merged.status} · ${at.slice(11, 16)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
