# Architecture reference — локална стрийминг платформа

Тази страница е записаният резултат от планирането в чата. Дръж я актуална, когато решения се променят — това е source of truth, не самата чат история.

## Изисквания (потвърдени)

- Custom приложение от нулата, self-hosted в заключена локална мрежа
- 10-50 потребители (малък екип/офис)
- Клиенти: браузър, Smart TV, iOS/Android, Android TV/Fire TV/Apple TV кутии
- Функции: профили + watchlist, resume playback, search/препоръки, субтитри + multi-audio, родителски контрол, Live TV/DVR

## Отворен въпрос — разрешен

"Заключена мрежа" — напълно air-gapped, или частна LAN/VLAN зад firewall с изходящ интернет? **Второто.** Потвърдено на практика: TMDB метаданните се теглят директно (заглавия, описания и жанрове на български, US рейтинги, постери свалени локално в `POSTER_ROOT`). Sneakernet не е нужен, и EPG за Live TV във Фаза 6 също ще може да се тегли директно.

## Сървър (потвърден)

| Компонент | Спецификация | Бележка |
|---|---|---|
| OS | Windows 11 Pro | Desktop OS, не Server — работи за този мащаб, но виж препоръките в SETUP.md за uptime |
| CPU | AMD Ryzen 7 7800X3D (8C/16T) | Достатъчен за backend/DB/оркестрация; може да служи и като software encode fallback (libx264) |
| RAM | 32 GB | Комфортно за Postgres + Redis + Docker + транскод буфери на този мащаб |
| GPU | AMD RX 7900 XTX (RDNA3, VCN 4.0) | Hardware encode през AMF (h264_amf/hevc_amf/av1_amf). **GPU capacity тест направен (12 август 2026):** и двата енкодера минаха чисто до 6 едновременни 1080p сесии, `OK-realtime` навсякъде, голям запас (5.3x/4.5x при 6 сесии). Виж `scripts/gpu-test/gpu-test-results.csv`. Едно реално ограничение открито: `h264_amf` не приема 10-bit вход директно (общо за хардуерни H.264 енкодери) — нужен `-vf format=nv12`, вече вграден в теста. |
| Storage | 1.82 TB общо, ~460 GB свободни | Достатъчно за текущата библиотека, след като транскодът получи битрейт контрол (13 август 2026): 75-те файла, които искат транскод, заемат ~196 GB вместо ~1240 GB. Преди това енкодерът работеше без `-rc` и произвеждаше 720p при 19.9 Mbps — по-голямо от 1080p източника. Разширение (диск/NAS) остава нужно за растеж, но вече не блокира. |

## Стек

| Слой | Избор | Защо |
|---|---|---|
| Backend API | Node.js + NestJS + PostgreSQL + Prisma | Типизиран, добра структура за domain modules (catalog, users, playback, live-tv) |
| Transcoding | FFmpeg + AMF (h264_amf/hevc_amf), **нативен Windows процес** — не в Docker | AMD GPU passthrough в WSL2/Docker Desktop е незрял за encode workloads (2026); нативен FFmpeg заобикаля целия проблем |
| Опашка за транскод jobs | BullMQ + Redis | Redis-ът е контейнеризиран, worker процесът достъпва GPU нативно |
| Streaming delivery | HLS packaging, Traefik reverse proxy пред backend | Стандарт, съвместим с всички клиенти |
| Web клиент | React/Next.js + hls.js | Базата за mobile/TV разширения |
| Mobile (iOS/Android) | React Native | Споделя логика с web |
| Android TV / Fire TV | React Native (react-native-tvos) | Fire OS е Android-базиран, едно приложение покрива и двете |
| Apple TV | Native Swift/tvOS, отделен проект | Не споделя код с RN; изисква Xcode + Apple Developer акаунт + поне еднократна интернет връзка за сертификати |
| Live TV tuner | HDHomeRun (network tuner) | Живее в LAN-а директно |
| Auth | Self-hosted JWT сесии или Keycloak за SSO по профили | Заключена мрежа ≠ trusted мрежа — auth остава задължителен |
| Reverse proxy / TLS | Traefik + локален CA (mkcert) | HTTPS в LAN без публичен домейн; всяко устройство трябва да довери CA-то еднократно |
| Search | Postgres full-text (v1) → Meilisearch по-късно ако трябва | Просто, без cloud зависимост |
| Observability | Prometheus + Grafana, self-hosted | Няма cloud телеметрия |

## Фазов план

- **Фаза 0 — Инфраструктура** ✅ Завършена.
  Docker Compose (Postgres, Redis, Traefik) е горе на сървъра. mkcert локален CA инсталиран, сертификат за `streaming.local` генериран. FFmpeg с AMF поддръжка инсталиран нативно. GPU capacity тестът мина чисто на 6 едновременни сесии за h264_amf и hevc_amf (детайли в GPU реда по-горе). Storage expansion (само ~460 GB свободни) остава отворена задача преди реален import на съдържание.
- **Фаза 1 — Backend ядро + ingestion + transcoding** ✅ Завършена.
  `MediaScannerService` сканира `MEDIA_ROOT`, чете метаданни през ffprobe,
  разпознава movie/episode по име и импортира (`POST /media/scan`). BullMQ
  опашка + worker извиква нативния FFmpeg AMF, добавя `-vf format=nv12` за
  10-bit източници на `h264_amf` и ограничава concurrency-то до
  `min(h264, hevc)`, защото двата енкодера споделят един физически AMF блок.
  Всичко е тествано срещу реален Postgres/Redis, не само компилирано.
  На 13 август 2026 добавени: дедупликация на транскод job-ове по
  `(mediaFileId, targetHeight)` и auth guard на `POST /media/scan` и
  `POST /transcode`.
- **Фаза 2 — Web клиент (VOD MVP)** ✅ Завършена.
  Next.js клиент: вход, каталог с TMDB постери, плейър. Direct play за
  browser-съвместими файлове (mp4/h264/aac — целият mp4 корпус на тази
  библиотека) с пълна HTTP Range поддръжка; hls.js за останалото. Потвърдено
  в браузър на 13 август 2026, включително превъртане в 24-минутен епизод.
- **Фаза 3 — Профили, resume, search, субтитри, родителски контрол**
  ✅ Завършена на 13 август 2026.
  Профили (multi-profile, избор в UI-то, екран за управление, PIN), resume и
  continue-watching, watchlist, търсене в каталога, субтитри към WebVTT,
  multi-audio с превключване по време на гледане, TMDB метаданни на български.
  Родителският контрол важи и при разглеждане, и при възпроизвеждане — капът
  пътува в JWT-то, а не като query параметър.
- **Фаза 4 — Mobile apps (iOS/Android)** ← тук сме сега
  React Native, споделя логиката с web клиента.

  **Готово:** транспортът. Traefik вече носи `streaming.local` и
  `api.streaming.local` (14 август 2026), тоест има един стабилен адрес, към
  който клиент може да сочи. Проверено, че `Range` и HLS минават през
  проксито. Виж `docs/SETUP.md` §6.

  **Ограничение, което трябва да се знае предварително: iOS не може да се
  build-не на тази машина.** Компилирането за iOS изисква macOS с Xcode —
  това е ограничение на Apple, не на проекта. Android е напълно постижим:
  на машината има JDK 21, Android SDK и `adb`. Вариантите за iOS са Mac,
  наето macOS в облак (Expo EAS и подобни), или отлагане.

  **Предстои:** RN проект, който ползва `api.streaming.local`; нативен HLS
  плейър (`react-native-video` — hls.js е само за web); и трансфер на
  профилната логика, включително PIN.
- **Фаза 5 — TV apps** (Android TV/Fire TV, после отделно Apple TV)
- **Фаза 6 — Live TV/DVR** (паралелна hardware линия — HDHomeRun + EPG + DVR scheduler)

## Ключови рискове

| Риск | Митигация |
|---|---|
| ~~GPU не издържа N едновременни транскод сесии~~ | **Разрешено.** Тествано до 6 едновременни за h264_amf/hevc_amf, всички `OK-realtime` с голям запас. `TRANSCODE_MAX_CONCURRENT_*` в `backend/.env.example` вече отразява това. Може да се тества по-високо по-късно ако трябва повече. |
| AMD AMF H.264 качество/стабилност под NVENC | На тази машина/драйвери не се потвърди — 6/6 сесии стабилни. Остави libx264 CPU fallback в дизайна като застраховка, но не блокирай на това. |
| `h264_amf` отхвърля 10-bit вход директно | **Открито в теста.** Транскод pipeline-ът трябва винаги да минава през `-vf format=nv12` (или еквивалент) преди h264_amf за 10-bit източници (чести при AV1/HEVC rip-ове). Вече вградено в `scripts/gpu-test/test-amf-capacity.ps1`, трябва да влезе и в реалния Phase 1 worker. |
| Apple TV изисква интернет за сертификати | Третирай като отделна фаза, извън "напълно заключено" очакването |
| Metadata/EPG зависят от интернет | Sneakernet fallback ако мрежата е напълно air-gapped |
| Обхватът наближава "построй Netflix" | Стриктен MVP scope (Фаза 0-3) преди native TV apps/Live TV |
| Недостатъчно свободно storage (~460 GB) | Разшири преди import на реална библиотека |
