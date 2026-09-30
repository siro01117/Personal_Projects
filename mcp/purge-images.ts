// 주인 없는 사진 치우기: 어느 보고서(살아 있든 휴지통이든)에도 안 쓰이고 올린 지 14일 넘은 사진을 Storage API 로 지운다.
// MCP 서버도 시작할 때마다 같은 일을 한다. 실행: npm run purge-images

import { loadEnv } from "./env";
import { toKorean } from "./errors";
import { purgeImages } from "./images";
import { SupabaseStore } from "./store-supabase";

const loaded = loadEnv();
if ("error" in loaded) {
  console.error(loaded.error);
  process.exit(1);
}
const { env } = loaded;
const store = new SupabaseStore(env.EZ_SUPABASE_URL, env.EZ_SUPABASE_SERVICE_ROLE_KEY, env.EZ_OWNER_ID);

try {
  const gone = await purgeImages(store);
  console.log(gone.length === 0 ? "지울 사진이 없습니다" : `주인 없는 사진 ${gone.length}장을 지웠습니다`);
} catch (e) {
  console.error(`사진 치우기 실패: ${toKorean(e).message}`);
  process.exit(1);
}
