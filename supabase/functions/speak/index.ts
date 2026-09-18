// 한 줄을 소리로 바꿔 돌려준다. 같은 줄은 한 번만 만들고 그 뒤로는 저장해 둔 것을 준다.
//
//   POST /functions/v1/speak   { "text": "...", "voice": "ko-KR-Chirp3-HD-Leda" }
//   -> audio/mpeg
//
// 사이트가 정적(output: 'export')이라 서버 함수를 둘 데가 여기뿐이다.
// 로그인한 사람만 부를 수 있다(verify_jwt 기본값). 키는 서버에만 있고 브라우저로 나가지 않는다.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const BUCKET = 'study-audio';
const DEFAULT_VOICE = Deno.env.get('TTS_VOICE') ?? 'ko-KR-Chirp3-HD-Leda';
const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const VOICES = 'https://texttospeech.googleapis.com/v1/voices';
// 부른 목소리가 없으면 이걸로 읽는다. 소리가 안 나는 것보다 낫다.
const FALLBACK_VOICE = 'ko-KR-Neural2-A';
const MAX_CHARS = 600;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function hash(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const key = Deno.env.get('GOOGLE_TTS_KEY');
  if (!key) return json({ error: 'GOOGLE_TTS_KEY 가 없다' }, 503);

  // GET 은 쓸 수 있는 한국어 목소리 목록. 키가 살아 있는지 확인하는 용도이기도 하다.
  if (req.method === 'GET') {
    const r = await fetch(`${VOICES}?languageCode=ko-KR&key=${key}`);
    if (!r.ok) return json({ error: '목소리 목록 실패', status: r.status, detail: (await r.text()).slice(0, 400) }, 502);
    const { voices = [] } = await r.json();
    return json({ default: DEFAULT_VOICE, voices: voices.map((v: { name: string }) => v.name).sort() }, 200);
  }
  if (req.method !== 'POST') return json({ error: 'POST 만 받는다' }, 405);

  let text = '';
  let voice = DEFAULT_VOICE;
  try {
    const body = await req.json();
    text = String(body.text ?? '').trim().slice(0, MAX_CHARS);
    if (body.voice) voice = String(body.voice);
  } catch {
    return json({ error: '{"text": "..."} 형태여야 한다' }, 400);
  }
  if (!text) return json({ error: 'text 가 비었다' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const path = `tts/${voice}/${await hash(`${voice}|${text}`)}.mp3`;

  // 이미 만든 줄이면 그대로 준다. 강의를 다시 들을 때나 문장이 겹칠 때 값이 안 나간다.
  const cached = await sb.storage.from(BUCKET).download(path);
  if (!cached.error && cached.data) {
    return new Response(await cached.data.arrayBuffer(), {
      headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000', 'X-Cache': 'hit' },
    });
  }

  const call = (name: string) => fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: 'ko-KR', name },
      // 빠르기는 브라우저에서 바꾼다 — 서버에서 바꾸면 빠르기마다 따로 저장돼 캐시가 쪼개진다.
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 },
    }),
  });

  let res = await call(voice);
  if (res.status === 400 && voice !== FALLBACK_VOICE) res = await call(FALLBACK_VOICE);
  if (!res.ok) {
    const detail = await res.text();
    return json({ error: '합성 실패', status: res.status, detail: detail.slice(0, 400) }, 502);
  }
  const { audioContent } = await res.json();
  if (!audioContent) return json({ error: '소리가 안 왔다' }, 502);

  const bytes = Uint8Array.from(atob(audioContent), (c) => c.charCodeAt(0));
  // 저장에 실패해도 소리는 돌려준다 — 다음에 다시 만들면 될 뿐이다.
  await sb.storage.from(BUCKET).upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });

  return new Response(bytes, {
    headers: { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000', 'X-Cache': 'miss' },
  });
});
