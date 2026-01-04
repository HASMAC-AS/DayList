import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appUrl = pathToFileURL(path.resolve(__dirname, '../../index.html')).href;

const resetStorage = async (page) => {
  await page.addInitScript(() => localStorage.clear());
};

test.describe('DayList e2e', () => {
  test('adds a daily task to today list', async ({ page }) => {
    await resetStorage(page);
    await page.goto(appUrl);

    const taskTitle = 'Drink water';
    await page.fill('#titleInput', taskTitle);
    await page.click('#addBtn');

    const todayTasks = page.locator('#todayList .task .title', { hasText: taskTitle });
    await expect(todayTasks).toHaveCount(1);
  });

  test('adds a scheduled task to upcoming list', async ({ page }) => {
    await resetStorage(page);
    await page.goto(appUrl);

    const taskTitle = 'Pay rent';
    await page.click('#typeScheduled');
    await page.fill('#titleInput', taskTitle);
    await page.fill('#dueInput', '2030-01-01T09:00');
    await page.click('#addBtn');

    await expect(page.locator('#upcomingCount')).toHaveText('1');
    await page.locator('#upcomingDetails').evaluate((node) => {
      node.open = true;
    });

    const upcomingTasks = page.locator('#upcomingList .task .title', { hasText: taskTitle });
    await expect(upcomingTasks).toHaveCount(1);
  });
});
