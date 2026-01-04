import { logicalDayKey } from './core';
import type { Task } from './types';

export interface TodaySections {
  dayKey: string;
  daily: Task[];
  scheduledDue: Task[];
  scheduledUpcoming: Task[];
}

export function isCompletedForDay(task: Pick<Task, 'completions'>, dayKey: string) {
  const m: any = task.completions;
  if (m && typeof m.get === 'function') return !!m.get(dayKey);
  return !!(m && typeof m === 'object' && m[dayKey]);
}

export function buildTodaySections(tasks: Task[], now: number = Date.now()): TodaySections {
  const dayKey = logicalDayKey(now);
  const daily: Task[] = [];
  const scheduledDue: Task[] = [];
  const scheduledUpcoming: Task[] = [];
  const orderValue = (task: Task) => (task.order == null ? task.createdAt || 0 : Number(task.order || 0));

  for (const task of tasks) {
    if (!task || task.archivedAt) continue;
    if (task.type === 'daily') {
      if (task.active !== false) daily.push(task);
    } else {
      const dueAt = task.dueAt || 0;
      if (dueAt <= now) scheduledDue.push(task);
      else scheduledUpcoming.push(task);
    }
  }

  daily.sort((a, b) => orderValue(a) - orderValue(b));
  scheduledDue.sort((a, b) => orderValue(a) - orderValue(b) || (a.dueAt || 0) - (b.dueAt || 0));
  scheduledUpcoming.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));

  return {
    dayKey,
    daily,
    scheduledDue,
    scheduledUpcoming
  };
}
