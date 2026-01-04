import { escapeHtml, formatDateTime, logicalDayKey } from './core.js';

export function isCompletedForDay(task, dayKey) {
  const m = task.completions;
  if (m && typeof m.get === 'function') return !!m.get(dayKey);
  if (m && typeof m === 'object') return !!m[dayKey];
  return false;
}

export function renderTaskRow(task, dayKey, opts = {}) {
  const completed = isCompletedForDay(task, dayKey);
  const due = task.type === 'scheduled' && task.dueAt
    ? `<span class="time">${escapeHtml(formatDateTime(task.dueAt))}</span>`
    : '';
  const badge = task.type === 'scheduled' ? '<span class="tag">scheduled</span>' : '<span class="tag">daily</span>';
  const upcomingHint = opts.upcoming ? '<span class="tag">upcoming</span>' : '';
  const titleCls = `title ${completed ? 'done' : ''}`;

  return `
    <div class="task" data-id="${escapeHtml(task.id)}">
      <label class="check">
        <input type="checkbox" class="toggle" ${completed ? 'checked' : ''} />
        <span></span>
      </label>
      <div class="main">
        <div class="rowline">
          <div class="${titleCls}" title="Double-click to rename">${escapeHtml(task.title)}</div>
          ${due}
        </div>
        <div class="meta">${badge} ${upcomingHint}</div>
      </div>
      <div class="actions">
        ${task.type === 'daily'
          ? `<button class="chip act" data-act="${task.active ? 'deactivate' : 'activate'}">${task.active ? 'Hide' : 'Show'}</button>`
          : ''}
        <button class="chip" data-act="archive">Archive</button>
      </div>
    </div>
  `;
}

export function buildTodaySections(tasks, now = Date.now()) {
  const dayKey = logicalDayKey(now);
  const daily = [];
  const scheduledDue = [];
  const scheduledUpcoming = [];

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

  daily.sort((a, b) => {
    const ca = isCompletedForDay(a, dayKey) ? 1 : 0;
    const cb = isCompletedForDay(b, dayKey) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    return a.title.localeCompare(b.title);
  });
  scheduledDue.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  scheduledUpcoming.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));

  const todayHtml = [];
  if (daily.length) {
    todayHtml.push('<div class="section-title">Daily</div>');
    todayHtml.push(daily.map(t => renderTaskRow(t, dayKey)).join(''));
  }
  if (scheduledDue.length) {
    todayHtml.push('<div class="section-title">Due now</div>');
    todayHtml.push(scheduledDue.map(t => renderTaskRow(t, dayKey)).join(''));
  }
  if (!todayHtml.length) todayHtml.push('<div class="empty">No tasks yet. Add one above 👆</div>');

  const upcomingHtml = scheduledUpcoming.length
    ? scheduledUpcoming.map(t => renderTaskRow(t, dayKey, { upcoming: true })).join('')
    : '<div class="empty">Nothing scheduled.</div>';

  return {
    dayKey,
    todayHtml: todayHtml.join(''),
    upcomingHtml,
    upcomingCount: scheduledUpcoming.length
  };
}
