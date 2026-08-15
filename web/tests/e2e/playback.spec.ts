import { expect, test } from '@playwright/test';

const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
const email = process.env.E2E_EMAIL ?? 'e2e@streaming.local';
const password = process.env.E2E_PASSWORD ?? 'E2E-Streaming-2608';
const mediaId = process.env.E2E_MEDIA_ID ?? '22000000-0000-0000-0000-000000000001';

test.beforeAll(async ({ request }) => {
  let auth = await request.post(`${apiUrl}/auth/login`, { data: { email, password } });
  if (auth.status() === 401) auth = await request.post(`${apiUrl}/auth/register`, { data: { email, password } });
  expect(auth.ok()).toBeTruthy();
  const { accessToken } = await auth.json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const profilesResponse = await request.get(`${apiUrl}/profiles`, { headers });
  const profiles = await profilesResponse.json();
  if (!profiles.some((profile: { name: string }) => profile.name === 'E2E Viewer')) {
    expect((await request.post(`${apiUrl}/profiles`, { headers, data: { name: 'E2E Viewer', isKid: false } })).ok()).toBeTruthy();
  }
});

test('login → profile → play → seek → Bulgarian subtitles', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: /Влез/ }).click();
  await expect(page).toHaveURL(/\/select-profile/);
  await page.getByRole('button', { name: /E2E Viewer/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText('E2E Playback Fixture', { exact: true }).first()).toBeVisible();

  await page.goto(`/watch/${mediaId}`);
  const video = page.locator('video');
  await expect(video).toBeVisible();
  await page.locator('.player-stage').hover();
  await page.getByRole('button', { name: 'Пускане' }).first().click();
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused)).toBe(true);

  const timeline = page.getByLabel('Позиция във видеото');
  await timeline.evaluate((element: HTMLInputElement) => { element.value = '4'; element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(2);

  const subtitles = page.getByLabel('Субтитри');
  await expect(subtitles.locator('option')).toContainText(['Български']);
  const bulgarianValue = await subtitles.locator('option').filter({ hasText: 'Български' }).first().getAttribute('value');
  expect(bulgarianValue).toBeTruthy();
  await subtitles.selectOption(bulgarianValue!);
  await expect(subtitles).not.toHaveValue('off');
});
