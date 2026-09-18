// 수업 정리 → 소리. 로컬에서만 돈다(서비스 키 + 로컬 TTS 서버가 필요).
//
//   node scripts/study-tts.mjs --list                          소리가 없거나 글이 바뀐 차시 목록
//   node scripts/study-tts.mjs --course 상법 --lesson 2026-09-08   한 차시
//   node scripts/study-tts.mjs --course 상법 --unit sanghup-u1    단원 강의 하나
//   node scripts/study-tts.mjs --all                           필요한 것 전부 (--only unit|lesson 로 한 종류만)
//   (--force 글이 안 바뀌었어도 다시 · --no-verify 받아쓰기 대조 생략 · --semester 2026-2)
//
// 흐름: kv 에서 차시를 읽어 읽을 줄 목록(lib/study-say.mjs)을 만든다 → 파이썬(tts_units.py)이 줄마다 합성해
//       audio.wav + cues.json 을 낸다 → ffmpeg 로 m4a → 비공개 버킷 study-audio 에 올린다 → 차시에 tts 를 적는다.
// kv 는 학기 통째로 한 덩어리라, 적을 때는 방금 다시 읽은 값에 tts 만 얹어 쓴다(그 사이 바뀐 걸 덮지 않게).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { saySig, sayUnits } from '../lib/study-say.mjs';
import { saySig as lecSig, sayUnits as lecUnits } from '../lib/lecture.mjs';

const SUPABASE_URL = 'https://ovnabmmofgujgefuamzn.supabase.co';
const BUCKET = 'study-audio';
const PY = 'C:/Users/PC/Documents/GitHub/cosyvoice-tts/.venv/Scripts/python.exe';
const TTS_PY = 'C:/Users/PC/OneDrive/Desktop/작업/lectures/tts/tts_units.py';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i += 1; }
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

const lessonsOf = (course) => course.sessions || course.lessons || course.classes || [];
const lessonId = (l, i) => String(l.id || l.date || `ls${i}`);
const slug = (s) => String(s).replace(/[^0-9A-Za-z가-힣._-]+/g, '-');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 실패 (exit ${r.status})`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvLocal();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('.env.local 에 SUPABASE_SERVICE_ROLE_KEY 가 없다');
  const sb = createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
  const kvKey = `study.${args.semester || '2026-2'}`;

  const read = async () => {
    const { data, error } = await sb.from('kv').select('v').eq('k', kvKey).maybeSingle();
    if (error) throw error;
    if (!data?.v) throw new Error(`${kvKey} 가 kv 에 없다`);
    return data.v;
  };

  const sem = await read();
  const jobs = [];
  for (const c of sem.courses || []) {
    // 차시 정리(4블록)
    lessonsOf(c).forEach((l, i) => {
      const units = sayUnits(l);
      if (!units.length) return;
      jobs.push({ kind: 'lesson', course: c, item: l, id: lessonId(l, i), units,
        sig: saySig(l), stale: !l.tts?.path || l.tts.sig !== saySig(l) });
    });
    // 단원 강의 — 훨씬 길다. 소리도 따로 만든다.
    (c.units || []).forEach((u) => {
      const units = lecUnits(u);
      if (!units.length) return;
      jobs.push({ kind: 'unit', course: c, item: u, id: u.id, units,
        sig: lecSig(u), stale: !u.tts?.path || u.tts.sig !== lecSig(u) });
    });
  }

  if (args.list) {
    for (const j of jobs) console.log(`${j.stale ? '필요' : '있음'}  ${j.kind === 'unit' ? '강의' : '차시'}  ${j.course.name}  ${j.id}  (${j.units.length}줄)`);
    return;
  }

  const picked = jobs.filter((j) => {
    if (args.course && j.course.name !== args.course && j.course.id !== args.course) return false;
    if (args.lesson && j.id !== args.lesson && j.item.date !== args.lesson) return false;
    if (args.unit && j.id !== args.unit) return false;
    if (args.only && j.kind !== args.only) return false;
    if (!args.all && !args.course) return false;
    return args.force || j.stale;
  });
  if (!picked.length) { console.log('만들 것이 없다'); return; }

  const { data: buckets } = await sb.storage.listBuckets();
  if (!(buckets || []).some((b) => b.name === BUCKET)) {
    const { error } = await sb.storage.createBucket(BUCKET, { public: false });
    if (error) throw error;
    console.log(`버킷 ${BUCKET} 생성 (비공개)`);
  }

  for (const j of picked) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'study-tts-'));
    const sig = j.sig;
    console.log(`\n== ${j.course.name} ${j.id} · ${j.units.length}줄`);
    fs.writeFileSync(path.join(work, 'units.json'), JSON.stringify(j.units), 'utf8');
    run(PY, [TTS_PY, path.join(work, 'units.json'), work, ...(args['no-verify'] ? [] : ['--verify'])]);
    run('ffmpeg', ['-v', 'error', '-y', '-i', path.join(work, 'audio.wav'),
      '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', path.join(work, 'audio.m4a')]);

    const cues = JSON.parse(fs.readFileSync(path.join(work, 'cues.json'), 'utf8'));
    const report = JSON.parse(fs.readFileSync(path.join(work, 'report.json'), 'utf8'));
    const low = report.filter((r) => r.score >= 0 && r.score < 0.72);
    for (const r of low) console.log(`  ! 잘못 읽었을 수 있음 [${r.k}:${r.i}] ${r.score}  들린 말: ${r.heard}`);

    // 경로에 글 지문을 넣는다 — 글이 바뀌면 새 파일이 되어 기기에 남은 옛 소리가 재생될 일이 없다.
    const objPath = `${slug(sem.id || args.semester || '2026-2')}/${slug(j.course.id || j.course.name)}/${slug(j.id)}.${sig}.m4a`;
    // 긴 강의는 파일이 8MB 를 넘는다. 한 번 끊겼다고 17분짜리 합성을 버리지 않는다.
    const body = fs.readFileSync(path.join(work, 'audio.m4a'));
    let upErr = null;
    for (let tryN = 1; tryN <= 3; tryN += 1) {
      ({ error: upErr } = await sb.storage.from(BUCKET).upload(objPath, body, { contentType: 'audio/mp4', upsert: true }));
      if (!upErr) break;
      console.log(`  올리기 실패 ${tryN}/3: ${upErr.message} — 다시 시도`);
      await new Promise((r) => { setTimeout(r, 3000 * tryN); });
    }
    if (upErr) throw upErr;

    const latest = await read();
    let done = false;
    for (const c of latest.courses || []) {
      if ((c.id || c.name) !== (j.course.id || j.course.name)) continue;
      const targets = j.kind === 'unit'
        ? (c.units || []).filter((u) => u.id === j.id).map((u) => [u, lecSig(u)])
        : lessonsOf(c).map((l, i) => [l, saySig(l), lessonId(l, i)]).filter((x) => x[2] === j.id);
      for (const [obj, curSig] of targets) {
        if (curSig !== sig) throw new Error('합성하는 사이 글이 바뀌었다 — 다시 돌릴 것');
        if (obj.tts?.path && obj.tts.path !== objPath) sb.storage.from(BUCKET).remove([obj.tts.path]).catch(() => {});
        obj.tts = { path: objPath, dur: cues.dur, sig, cues: cues.cues };
        done = true;
      }
    }
    if (!done) throw new Error('차시를 다시 찾지 못했다');
    const { error: wErr } = await sb.from('kv').update({ v: latest, updated_at: new Date().toISOString() }).eq('k', kvKey);
    if (wErr) throw wErr;
    const kb = Math.round(fs.statSync(path.join(work, 'audio.m4a')).size / 1024);
    console.log(`  올림: ${objPath} · ${cues.dur}s · ${kb}KB · 의심 ${low.length}줄`);
    fs.rmSync(work, { recursive: true, force: true });   // 성공했을 때만 지운다
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
