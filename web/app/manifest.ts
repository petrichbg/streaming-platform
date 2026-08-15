import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Кино у дома',
    short_name: 'Кино',
    description: 'Лична библиотека за филми и сериали',
    start_url: '/',
    display: 'standalone',
    background_color: '#080b0f',
    theme_color: '#080b0f',
    orientation: 'any',
    icons: [{ src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  };
}
