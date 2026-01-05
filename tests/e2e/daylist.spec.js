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
    await page.click('button[aria-label="Add task"]');
    await page.fill('#titleInput', taskTitle);
    await page.click('#addBtn');

    const todayTasks = page.locator('#todayList .task .title', { hasText: taskTitle });
    await expect(todayTasks).toHaveCount(1);
  });

  test('adds a scheduled task to upcoming list', async ({ page }) => {
    await resetStorage(page);

    const taskTitle = 'Pay rent';
    await page.click('button[aria-label="Add task"]');
    await page.click('#typeScheduled');
    await page.fill('#titleInput', taskTitle);
    await page.fill('#dueInput', '2030-01-01T09:00');
    await page.click('#addBtn');

    await page.click('button[aria-label="Open settings"]');
    const upcomingTasks = page.locator('.settings-view #upcomingList .task .title', { hasText: taskTitle });
    await expect(upcomingTasks).toHaveCount(1);
  });

  test('isolates tasks and suggestions per list', async ({ page }) => {
    await resetStorage(page);

    await page.click('button[aria-label="Open settings"]');
    await page.locator('summary', { hasText: 'Lists' }).click();
    await page.locator('.list-create input[type="text"]').fill('Work');
    await page.locator('.list-create button').click();

    await page.click('button[aria-label="Back"]');

    await page.click('button[aria-label="Add task"]');
    await page.fill('#titleInput', 'Send report');
    await page.click('#addBtn');
    await expect(page.locator('#todayList .task .title', { hasText: 'Send report' })).toHaveCount(1);

    await page.click('[aria-label="Active list"]');
    await page.locator('.multiselect-option', { hasText: 'Main' }).click();
    await expect(page.locator('#todayList .task .title', { hasText: 'Send report' })).toHaveCount(0);

    await page.click('button[aria-label="Add task"]');
    await page.fill('#titleInput', 'Grocery run');
    await page.click('#addBtn');
    await expect(page.locator('#todayList .task .title', { hasText: 'Grocery run' })).toHaveCount(1);

    await page.click('[aria-label="Active list"]');
    await page.locator('.multiselect-option', { hasText: 'Work' }).click();
    await expect(page.locator('#todayList .task .title', { hasText: 'Grocery run' })).toHaveCount(0);

    await page.click('button[aria-label="Add task"]');
    await page.fill('#titleInput', 'Grocery');
    await expect(page.locator('#suggestions .sugg')).toHaveCount(0);
  });
});
