// 볼트의 강의 마크다운 -> 사이트의 단원 강의(kv). 로컬 전용.
//
//   node scripts/lecture-import.mjs "<md 경로>" --course 상법 --id sanghup-u1 [--dry]
//
// 내가 쓰는 마크다운 관례만 읽는다:
//   # 제목 (교재 92~131쪽)        -> title / pages
//   ## · ### 소제목               -> h
//   ```  ```                      -> map (오늘 갈 길)
//   > **먼저 생각해보기**          -> pre        > **멈춰서 답해보기**  -> q
//   > [!success]- 답 확인          -> 바로 앞 q 의 답
//   > [!note]- 제목                -> note (접어둠)
//   *여기서 막히면: …*             -> hint
//   | a | b |                     -> table      - 항목              -> ul
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { saySig } from '../lib/lecture.mjs';

const SUPABASE_URL = 'https://ovnabmmofgujgefuamzn.supabase.co';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
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

// 화면은 순수 텍스트만 그린다 — 마크다운 표시는 여기서 걷어낸다.
const plain = (s) => String(s)
  .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
  .replace(/\[\[([^\]]+)\]\]/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

function parse(md) {
  const lines = md.replace(/\r/g, '').split('\n');
  let i = 0;
  if (lines[0] === '---') {                               // frontmatter
    i = lines.indexOf('---', 1) + 1;
  }
  const doc = { title: '', pages: '', frame: '', lead: '', blocks: [] };
  const push = (b) => doc.blocks.push(b);
  let para = [];
  const flush = () => {
    const t = plain(para.join(' '));
    para = [];
    if (t) push({ t: 'p', text: t });
  };

  for (; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();

    if (!line.trim()) { flush(); continue; }

    if (line.startsWith('# ')) {                          // 제목 + 쪽수
      flush();
      const t = plain(line.slice(2));
      const m = t.match(/^(.*?)\s*[—-]\s*(.*?)\s*\(교재\s*([0-9~\-]+)쪽\)\s*$/);
      if (m) { doc.title = m[2]; doc.pages = m[3]; } else { doc.title = t; }
      continue;
    }
    if (/^#{2,4} /.test(line)) {                          // 소제목
      flush();
      push({ t: 'h', text: plain(line.replace(/^#+\s*/, '')) });
      continue;
    }
    if (line.startsWith('---')) { flush(); continue; }    // 구분선은 화면에서 안 쓴다

    if (line.startsWith('```')) {                         // 오늘 갈 길
      flush();
      const items = [];
      for (i += 1; i < lines.length && !lines[i].startsWith('```'); i += 1) {
        const t = plain(lines[i].replace(/^\s*\d+\.\s*/, ''));
        if (t) items.push(t);
      }
      push({ t: 'map', items });
      continue;
    }

    if (line.startsWith('|')) {                           // 표
      flush();
      const rows = [];
      for (; i < lines.length && lines[i].trimStart().startsWith('|'); i += 1) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(plain);
        if (cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')) || !c)) continue;
        rows.push(cells);
      }
      i -= 1;
      if (rows.length) {
        const head = rows[0].some(Boolean) ? rows[0] : [];
        push({ t: 'table', head, rows: head.length ? rows.slice(1) : rows });
      }
      continue;
    }

    if (line.startsWith('>')) {                           // 인용 묶음
      flush();
      const buf = [];
      for (; i < lines.length && lines[i].trimStart().startsWith('>'); i += 1) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      i -= 1;
      const head = buf[0] || '';
      const body = plain(buf.slice(1).join(' '));
      if (/\[!success\]/.test(head)) {
        const last = [...doc.blocks].reverse().find((b) => b.t === 'q');
        if (last) last.a = body;
        continue;
      }
      if (/\[!note\]/.test(head)) {
        push({ t: 'note', title: plain(head.replace(/\[!note\]-?\s*/, '')) || '곁가지', text: body });
        continue;
      }
      if (/먼저 생각해보기/.test(head)) { push({ t: 'pre', q: body }); continue; }
      if (/멈춰서 답해보기/.test(head)) { push({ t: 'q', q: body, a: '' }); continue; }
      // 문서 머리말 = 이 강의가 무엇인지. 첫 줄만 lead 로 쓰고 나머지는 버린다(링크 안내라 읽을 것이 아니다).
      const all = plain(buf.join(' '));
      if (!doc.lead && !doc.blocks.length) {
        // 머리말은 볼트용 안내라 첫 문장만 쓴다. 나머지는 링크 안내라 화면에서 의미가 없다.
        doc.lead = (plain(buf[0]).split(/(?<=\.)\s/)[0] || '').trim();
        const fm = all.match(/(?:상법 )?과목 틀의\s*([^.]*?칸[^.]*?)(?:\s*이다|\.|$)/);
        if (fm) doc.frame = `과목 틀 ${fm[1].trim()}`;
      }
      continue;
    }

    if (/^\s*\*여기서 막히면/.test(line)) {                // 막힘 출구
      flush();
      push({ t: 'hint', text: plain(line) });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {                       // 목록
      flush();
      const items = [];
      for (; i < lines.length && /^\s*[-*]\s+/.test(lines[i]); i += 1) {
        items.push(plain(lines[i].replace(/^\s*[-*]\s+/, '')));
      }
      i -= 1;
      push({ t: 'ul', items: items.filter(Boolean) });
      continue;
    }

    para.push(line.trim());
  }
  flush();
  return doc;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mdPath = args._[0];
  if (!mdPath) throw new Error('마크다운 경로가 필요하다');
  const doc = parse(fs.readFileSync(mdPath, 'utf8'));
  doc.id = String(args.id || path.basename(mdPath, '.md'));
  if (args.title) doc.title = String(args.title);
  if (args.pages) doc.pages = String(args.pages);

  const counts = doc.blocks.reduce((m, b) => ({ ...m, [b.t]: (m[b.t] || 0) + 1 }), {});
  console.log(`제목: ${doc.title} | 교재 ${doc.pages}쪽 | 블록 ${doc.blocks.length}`, counts);
  const noAnswer = doc.blocks.filter((b) => b.t === 'q' && !b.a).length;
  if (noAnswer) console.log(`  ! 답이 안 붙은 멈춤 질문 ${noAnswer}개 — 인출은 답 확인이 있어야 효과가 난다`);
  if (args.dry) { console.log(JSON.stringify(doc, null, 1).slice(0, 1500)); return; }

  loadEnvLocal();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('.env.local 에 SUPABASE_SERVICE_ROLE_KEY 가 없다');
  const sb = createClient(SUPABASE_URL, key, { auth: { persistSession: false } });
  const kvKey = `study.${args.semester || '2026-2'}`;
  const { data, error } = await sb.from('kv').select('v').eq('k', kvKey).maybeSingle();
  if (error) throw error;
  const sem = data.v;
  const course = sem.courses.find((c) => c.name === args.course || c.id === args.course);
  if (!course) throw new Error(`과목을 못 찾았다: ${args.course}`);
  course.units = course.units || [];
  const prev = course.units.find((u) => u.id === doc.id);
  if (prev) {
    // 글이 그대로면 이미 만든 소리를 살린다. 바뀌었으면 tts 를 떼서 다시 만들게 한다.
    if (prev.tts && prev.tts.sig === saySig(doc)) doc.tts = prev.tts;
    course.units[course.units.indexOf(prev)] = doc;
  } else {
    course.units.push(doc);
  }
  const { error: wErr } = await sb.from('kv').update({ v: sem, updated_at: new Date().toISOString() }).eq('k', kvKey);
  if (wErr) throw wErr;
  console.log(`${course.name} 에 저장 · 단원 ${course.units.length}개 · 소리 ${doc.tts ? '유지' : '다시 필요'}`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
