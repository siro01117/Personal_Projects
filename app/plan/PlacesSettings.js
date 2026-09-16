'use client';

/* ---------------------------------------------------------------------------
   설정 > 지점·이동시간.

   자주 가는 지점 몇 개를 적어두고 그 사이 이동시간만 채운다. 지점 n 개면 쌍은
   n(n-1)/2 개 — 4군데면 6칸. 방향은 구분하지 않는다(왕복 같은 시간으로 본다).
   행렬에 없는 일회성 장소는 일정마다 이동시간을 직접 적는다(EditSheet).
--------------------------------------------------------------------------- */

import { Home, Plus, X } from 'lucide-react';
import { travelKey, travelPairs, uid } from '../../lib/plan-core';

const MAX = 8;

export default function PlacesSettings({ settings, onChange }) {
  const places = settings.places || [];
  const pairs = travelPairs(places);

  const setPlaces = (next) => onChange((s) => {
    const ids = new Set(next.map((p) => p.id));
    // 지운 지점이 끼어 있던 쌍은 같이 버린다 — 안 그러면 유령 값이 남는다
    const travel = Object.fromEntries(
      Object.entries(s.travel || {}).filter(([k]) => k.split('|').every((id) => ids.has(id))),
    );
    return { ...s, places: next, travel, homeId: ids.has(s.homeId) ? s.homeId : '' };
  });

  const add = () => setPlaces([...places, { id: uid('pl'), name: '' }]);
  const rename = (id, name) => setPlaces(places.map((p) => (p.id === id ? { ...p, name } : p)));
  const remove = (id) => setPlaces(places.filter((p) => p.id !== id));
  const setHome = (id) => onChange((s) => ({ ...s, homeId: s.homeId === id ? '' : id }));

  const setTravel = (a, b, raw) => onChange((s) => {
    const k = travelKey(a, b);
    const n = Math.max(0, Number(String(raw).replace(/[^\d]/g, '')) || 0);
    const travel = { ...(s.travel || {}) };
    if (n > 0) travel[k] = n; else delete travel[k];
    return { ...s, travel };
  });

  const named = places.filter((p) => p.name.trim());
  const filled = pairs.filter(([a, b]) => (settings.travel || {})[travelKey(a.id, b.id)] > 0).length;

  return (
    <>
      <div className="rk-field">
        <dt>지점</dt>
        <dd>
          <ul className="rk-pl-places">
            {places.map((p) => (
              <li key={p.id}>
                <input
                  className="rk-input" value={p.name} placeholder="이름 (집 · 학교 · …)"
                  onChange={(e) => rename(p.id, e.target.value)}
                />
                <button
                  type="button"
                  className={'rk-pl-home' + (settings.homeId === p.id ? ' is-on' : '')}
                  onClick={() => setHome(p.id)}
                  aria-pressed={settings.homeId === p.id}
                  title="하루의 시작·끝 기준점"
                >
                  <Home size={14} strokeWidth={1.5} aria-hidden="true" />집
                </button>
                <button type="button" className="rk-pl-place-x" onClick={() => remove(p.id)} aria-label={`${p.name || '지점'} 지우기`}>
                  <X size={15} strokeWidth={1.5} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {places.length < MAX && (
            <button type="button" className="rk-pl-place-add" onClick={add}>
              <Plus size={14} strokeWidth={1.5} aria-hidden="true" />지점 추가
            </button>
          )}
          <p className="rk-pl-hint">
            집으로 지정한 곳이 하루의 시작·끝입니다. 지정하지 않으면 오갈 때 드는 왕복 시간을 세지 않습니다.
          </p>
        </dd>
      </div>

      <div className="rk-field">
        <dt>이동시간</dt>
        <dd>
          {named.length < 2 ? (
            <p className="rk-pl-hint">지점을 두 곳 이상 적으면 그 사이 이동시간 칸이 생깁니다.</p>
          ) : (
            <>
              <ul className="rk-pl-travel">
                {pairs.map(([a, b]) => (
                  <li key={travelKey(a.id, b.id)}>
                    <span className="rk-pl-travel-n">
                      {a.name || '이름 없음'} <i aria-hidden="true">↔</i> {b.name || '이름 없음'}
                    </span>
                    <input
                      className="rk-input rk-pl-travel-i" inputMode="numeric"
                      value={(settings.travel || {})[travelKey(a.id, b.id)] || ''}
                      placeholder="0"
                      onChange={(e) => setTravel(a.id, b.id, e.target.value)}
                      aria-label={`${a.name} 에서 ${b.name} 까지 분`}
                    />
                    <span className="rk-pl-travel-u">분</span>
                  </li>
                ))}
              </ul>
              <p className="rk-pl-hint">
                {filled} / {pairs.length} 칸. 비워두면 그 쌍은 이동시간 0으로 봅니다 — 모르는 값을 지어내지 않습니다.
                오가는 시간은 빈 시간에서 빠지고 그 날의 부담에도 더해집니다.
              </p>
            </>
          )}
        </dd>
      </div>
    </>
  );
}
