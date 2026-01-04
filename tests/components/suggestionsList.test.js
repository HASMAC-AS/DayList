import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SuggestionsList from '../../src/components/SuggestionsList.vue';

const items = [
  {
    key: 'drink-water',
    title: 'Drink water',
    usageCount: 3,
    firstUsedAt: 0,
    lastUsedAt: 0,
    meanMinutes: 480,
    lastType: 'daily',
    usageLabel: '- used 3x',
    lastLabel: '- last 2024-01-01 08:00',
    timeLabel: '- ~08:00'
  }
];

describe('SuggestionsList', () => {
  it('emits pick when a suggestion is clicked', async () => {
    const wrapper = mount(SuggestionsList, {
      props: { items }
    });

    await wrapper.find('.sugg').trigger('click');
    expect(wrapper.emitted('pick')[0][0].key).toBe('drink-water');
  });
});
