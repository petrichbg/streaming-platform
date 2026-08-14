import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Кино у дома',
    template: '%s · Кино у дома',
  },
  description: 'Лична библиотека за филми и сериали.',
};

export const viewport: Viewport = {
  themeColor: '#080b0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg">
      <body>
        <a className="skip-link" href="#main-content">
          Към съдържанието
        </a>
        {children}
      </body>
    </html>
  );
}
