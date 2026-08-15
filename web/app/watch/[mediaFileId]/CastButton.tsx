'use client';

import { useEffect, useState } from 'react';

declare global {
  interface Window { cast?: any; chrome?: any; __onGCastApiAvailable?: (available: boolean) => void }
}

interface Props { sourceUrl: string | null; contentType: string; title: string }

export function CastButton({ sourceUrl, contentType, title }: Props) {
  const appId = process.env.NEXT_PUBLIC_CAST_APP_ID;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!appId || !window.isSecureContext) return;
    window.__onGCastApiAvailable = (available) => {
      if (!available) return;
      const context = window.cast.framework.CastContext.getInstance();
      context.setOptions({ receiverApplicationId: appId, autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      setReady(true);
    };
    if (!document.querySelector('script[data-cast-sdk]')) {
      const script = document.createElement('script');
      script.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
      script.async = true;
      script.dataset.castSdk = 'true';
      document.head.appendChild(script);
    }
  }, [appId]);

  if (!appId) return null;
  async function castMedia() {
    if (!ready || !sourceUrl) return;
    setError(null);
    try {
      const context = window.cast.framework.CastContext.getInstance();
      await context.requestSession();
      const media = new window.chrome.cast.media.MediaInfo(sourceUrl, contentType);
      media.metadata = new window.chrome.cast.media.GenericMediaMetadata();
      media.metadata.title = title;
      await context.getCurrentSession().loadMedia(new window.chrome.cast.media.LoadRequest(media));
    } catch (err) { setError(err instanceof Error ? err.message : 'Cast връзката не бе установена'); }
  }
  return <div className="cast-control"><button type="button" disabled={!ready || !sourceUrl} onClick={() => void castMedia()}>Cast към телевизор</button>{error && <span>{error}</span>}</div>;
}
