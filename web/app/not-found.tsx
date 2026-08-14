import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="not-found-page" id="main-content">
      <span className="not-found-code">404</span>
      <div>
        <span className="eyebrow">Изгубен кадър</span>
        <h1>Тази страница не е в програмата.</h1>
        <p className="muted">Върни се към библиотеката и избери нещо за гледане.</p>
        <Link className="button-link" href="/">Към библиотеката</Link>
      </div>
    </main>
  );
}
