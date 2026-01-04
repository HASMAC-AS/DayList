import { describe, expect, it } from 'vitest';
import { logicalDayKey } from '../core.js';
import { buildTodaySections } from '../todayView.js';

const countTasks = (html) => (html.match(/class="task"/g) || []).length;

describe('today view persistence', () => {
  it('shows all today tasks after refresh', () => {
    const now = new Date(2024, 0, 2, 9, 0, 0, 0).getTime();
    const dayKey = logicalDayKey(now);
    const tasks = [
      {
        id: 'daily-1',
        title: 'Daily workout',
        type: 'daily',
        active: true,
        archivedAt: null,
        completions: { [dayKey]: true }
      },
      {
        id: 'daily-2',
        title: 'Daily journal',
        type: 'daily',
        active: true,
        archivedAt: null,
        completions: {}
      },
      {
        id: 'scheduled-1',
        title: 'Pay rent',
        type: 'scheduled',
        active: true,
        archivedAt: null,
        dueAt: now - 15 * 60 * 1000,
        completions: {}
      },
      {
        id: 'scheduled-2',
        title: 'Dentist appointment',
        type: 'scheduled',
        active: true,
        archivedAt: null,
        dueAt: now + 2 * 60 * 60 * 1000,
        completions: {}
      }
    ];

    const before = buildTodaySections(tasks, now);
    const refreshedTasks = JSON.parse(JSON.stringify(tasks));
    const after = buildTodaySections(refreshedTasks, now);

    expect(countTasks(before.todayHtml)).toBe(3);
    expect(countTasks(after.todayHtml)).toBe(3);
    expect(before.todayHtml).toContain('Daily workout');
    expect(after.todayHtml).toContain('Daily workout');
    expect(after.todayHtml).toContain('Daily journal');
    expect(after.todayHtml).toContain('Pay rent');
    expect(after.todayHtml).toContain('done');
    expect(after.upcomingCount).toBe(1);
    expect(after.upcomingHtml).toContain('Dentist appointment');
  });
});
