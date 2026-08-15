'use client';

import { useEffect } from 'react';

const SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isTvDevice() {
  const ua = navigator.userAgent;
  return new URLSearchParams(location.search).get('tv') === '1' ||
    localStorage.getItem('streaming_tv_mode') === '1' ||
    /Android TV|AFT|SmartTV|Tizen|Web0S|NetCast/i.test(ua);
}

export default function TvNavigation() {
  useEffect(() => {
    if (!isTvDevice()) return;
    localStorage.setItem('streaming_tv_mode', '1');
    document.body.classList.add('tv-mode');

    const candidates = () => Array.from(document.querySelectorAll<HTMLElement>(SELECTOR)).filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
    });

    const focusFirst = () => {
      if (!(document.activeElement instanceof HTMLElement) || document.activeElement === document.body) candidates()[0]?.focus();
    };
    const timer = window.setTimeout(focusFirst, 250);

    const onKeyDown = (event: KeyboardEvent) => {
      const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as const)[event.key as 'ArrowLeft'];
      if (!direction) {
        if ((event.key === 'Escape' || event.key === 'BrowserBack') && !location.pathname.startsWith('/watch/')) history.back();
        return;
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!active) return focusFirst();
      if (active.matches('input, select, textarea') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
      const from = active.getBoundingClientRect();
      const cx = from.left + from.width / 2;
      const cy = from.top + from.height / 2;
      const [dx, dy] = direction;
      const target = candidates().filter((node) => node !== active).map((node) => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2 - cx;
        const y = rect.top + rect.height / 2 - cy;
        const forward = x * dx + y * dy;
        const cross = Math.abs(x * dy - y * dx);
        return { node, forward, score: forward + cross * 2.5 };
      }).filter(({ forward }) => forward > 8).sort((a, b) => a.score - b.score)[0]?.node;
      if (target) {
        event.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.clearTimeout(timer); window.removeEventListener('keydown', onKeyDown); document.body.classList.remove('tv-mode'); };
  }, []);
  return null;
}
