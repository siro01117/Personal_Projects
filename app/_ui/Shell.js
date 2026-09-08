'use client';

// 모든 화면이 함께 쓰는 껍데기: 헤더 + 테마 토글 + 사용자 메뉴(로그아웃).
import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Moon, Sun, User } from 'lucide-react';
import { signOut } from '../../lib/supabase';

const THEME_KEY = 'rakan.theme';

// layout.js 의 인라인 스크립트가 첫 페인트 전에 <html data-theme> 을 이미 박아뒀다.
// 여기서는 그 값을 읽어 맞추기만 한다 — 다시 계산하면 깜빡인다.
export function useTheme() {
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  }, []);
  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem(THEME_KEY, next); } catch {}
      return next;
    });
  }, []);
  return [theme, toggle];
}

export default function Shell({ session, title, sub, nav, children, wide }) {
  const [theme, toggleTheme] = useTheme();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const meta = session?.user?.user_metadata || {};
  const who = meta.name || meta.login_id || (session?.user?.email || '').split('@')[0] || '사용자';

  return (
    <div className="rk-app">
      <a className="rk-skip" href="#main">본문으로 건너뛰기</a>

      <header className="rk-head">
        <div className={'rk-head-in' + (wide ? ' is-wide' : '')}>
          <a className="rk-brand" href="/">Ra<i>_</i>Kan</a>
          {nav}
          <div className="rk-head-r">
            <button
              className="rk-icon" type="button" onClick={toggleTheme}
              aria-label={theme === 'dark' ? '밝은 화면으로' : '어두운 화면으로'}
            >
              {theme === 'dark'
                ? <Sun size={18} strokeWidth={1.5} aria-hidden="true" />
                : <Moon size={18} strokeWidth={1.5} aria-hidden="true" />}
            </button>

            <div className="rk-menu-wrap" ref={menuRef}>
              <button
                className={'rk-icon' + (menu ? ' is-on' : '')} type="button"
                onClick={() => setMenu((v) => !v)}
                aria-haspopup="menu" aria-expanded={menu} aria-label="사용자 메뉴"
              >
                <User size={18} strokeWidth={1.5} aria-hidden="true" />
              </button>
              {menu && (
                <div className="rk-menu" role="menu">
                  <div className="rk-menu-who">{who}</div>
                  <button className="rk-menu-item" type="button" role="menuitem" onClick={() => signOut()}>
                    <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
                    로그아웃
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {(title || sub) && (
        <div className={'rk-mast' + (wide ? ' is-wide' : '')}>
          {title && <h1 className="rk-mast-t">{title}</h1>}
          {sub && <p className="rk-mast-s">{sub}</p>}
        </div>
      )}

      <main id="main" className={'rk-main' + (wide ? ' is-wide' : '')}>{children}</main>
    </div>
  );
}
