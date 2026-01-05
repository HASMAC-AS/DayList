import { describe, expect, it } from 'vitest';
import { logicalDayKey } from '../src/lib/core.ts';
import { buildTodaySections, isCompletedForDay } from '../src/lib/todayModel.ts';

const taskTitles = (list) => list.map((task) => task.title);

describe('today model persistence', () => {
  it('keeps today sections stable after refresh', () => {
    const now = new Date(2024, 0, 2, 9, 0, 0, 0).getTime();
    const dayKey = logicalDayKey(now);
    const tasks = [
      {
        id: 'daily-1',
        listId: 'default',
        title: 'Daily workout',
        type: 'daily',
        active: true,
        archivedAt: null,
        createdAt: now,
        dueAt: null,
        doneAt: null,
        templateKey: null,
        completions: { [dayKey]: true }
      },
      {
        id: 'daily-2',
        listId: 'default',
        title: 'Daily journal',
        type: 'daily',
        active: true,
        archivedAt: null,
        createdAt: now,
        dueAt: null,
        doneAt: null,
        templateKey: null,
        completions: {}
      },
      {
        id: 'scheduled-1',
        listId: 'default',
        title: 'Pay rent',
        type: 'scheduled',
        active: true,
        archivedAt: null,
        createdAt: now,
        dueAt: now - 15 * 60 * 1000,
        doneAt: null,
        templateKey: null,
        completions: {}
      },
      {
        id: 'scheduled-2',
        listId: 'default',
        title: 'Dentist appointment',
        type: 'scheduled',
        active: true,
        archivedAt: null,
        createdAt: now,
        dueAt: now + 2 * 60 * 60 * 1000,
        doneAt: null,
        templateKey: null,
        completions: {}
      }
    ];

    const before = buildTodaySections(tasks, now);
    const refreshedTasks = JSON.parse(JSON.stringify(tasks));
    const after = buildTodaySections(refreshedTasks, now);

    expect(before.daily).toHaveLength(2);
    expect(before.scheduledDue).toHaveLength(1);
    expect(before.scheduledUpcoming).toHaveLength(1);

    expect(after.daily).toHaveLength(2);
    expect(after.scheduledDue).toHaveLength(1);
    expect(after.scheduledUpcoming).toHaveLength(1);

    expect(taskTitles(after.daily)).toEqual(['Daily journal', 'Daily workout']);
    expect(taskTitles(after.scheduledDue)).toEqual(['Pay rent']);
    expect(taskTitles(after.scheduledUpcoming)).toEqual(['Dentist appointment']);

    expect(isCompletedForDay(after.daily[1], dayKey)).toBe(true);
  });
});
