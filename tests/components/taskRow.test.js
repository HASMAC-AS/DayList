import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TaskRow from '../../src/components/TaskRow.vue';

const buildTask = (overrides = {}) => ({
  id: 'task-1',
  listId: 'default',
  title: 'Morning run',
  type: 'daily',
  createdAt: Date.now(),
  dueAt: null,
  active: true,
  archivedAt: null,
  doneAt: null,
  templateKey: null,
  completions: {},
  ...overrides
});

describe('TaskRow', () => {
  it('renders completion state and emits toggle/archive', async () => {
    const dayKey = '2024-01-02';
    const task = buildTask({ completions: { [dayKey]: true } });

    const wrapper = mount(TaskRow, {
      props: {
        task,
        dayKey
      }
    });

    expect(wrapper.find('.title').classes()).toContain('done');
    expect(wrapper.find('input.toggle').element.checked).toBe(true);

    await wrapper.find('input.toggle').setValue(false);
    expect(wrapper.emitted('toggle')[0]).toEqual([task.id, false]);

    await wrapper.find('button.task-action.archive').trigger('click');
    expect(wrapper.emitted('archive')[0]).toEqual([task.id]);
  });
});
