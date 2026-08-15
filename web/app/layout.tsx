import type { Metadata, Viewport } from 'next';
import 'bootstrap/dist/css/bootstrap.min.css';
import './globals.css';
import TvNavigation from './TvNavigation';

export const metadata: Metadata = {
  title: {
    default: 'Кино у дома',
    template: '%s · Кино у дома',
  },
  description: 'Лична библиотека за филми и сериали.',
  icons: {
    icon: '/favicon.ico',
  },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Кино у дома' },
};

export const viewport: Viewport = {
  themeColor: '#080b0f',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg">
      <body>
        <TvNavigation />
        <a className="skip-link" href="#main-content">
          Към съдържанието
        </a>
        {children}
      </body>
    </html>
  );
}
