import { test, expect } from '@playwright/test';

const resetStorage = async (page) => {
  await page.goto('/');
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('daylist-v1');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });
  await page.reload();
};

test.describe('DayList e2e', () => {
  test('adds a daily task to today list', async ({ page }) => {
    await resetStorage(page);

    const taskTitle = 'Drink water';
    await page.fill('#titleInput', taskTitle);
    await page.click('#addBtn');

    const todayTasks = page.locator('#todayList .task .title', { hasText: taskTitle });
    await expect(todayTasks).toHaveCount(1);
  });

  test('adds a scheduled task to upcoming list', async ({ page }) => {
    await resetStorage(page);

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
