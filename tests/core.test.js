import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOUNDARY_HOUR,
  DAY_MS,
  circularMinuteDistance,
  debounce,
  errToObj,
  escapeHtml,
  formatDateTime,
  localDateKeyFrom,
  logicalDayKey,
  minutesOfDay,
  normalizeTitle,
  pad2,
  parseDatetimeLocalValue,
  parseSignalingList,
  randomKey,
  redact,
  suggestionScore,
  toDatetimeLocalValue,
  toJsonSafe
} from '../src/lib/core.ts';

describe('core utilities', () => {
  it('pads numbers to two digits', () => {
    expect(pad2(3)).toBe('03');
    expect(pad2(12)).toBe('12');
  });

  it('formats local date keys and logical day keys', () => {
    const morning = new Date(2024, 0, 2, 9, 15).getTime();
    expect(localDateKeyFrom(morning)).toBe('2024-01-02');

    const beforeBoundary = new Date(2024, 0, 2, BOUNDARY_HOUR - 1, 30).getTime();
    expect(logicalDayKey(beforeBoundary)).toBe('2024-01-01');

    const afterBoundary = new Date(2024, 0, 2, BOUNDARY_HOUR + 1, 0).getTime();
    expect(logicalDayKey(afterBoundary)).toBe('2024-01-02');
  });

  it('calculates minutes of day and circular distances', () => {
    const ts = new Date(2024, 0, 2, 1, 30).getTime();
    expect(minutesOfDay(ts)).toBe(90);
    expect(circularMinuteDistance(10, 20)).toBe(10);
    expect(circularMinuteDistance(1430, 10)).toBe(20);
  });

  it('formats date/time strings consistently', () => {
    const ts = new Date(2024, 0, 2, 5, 6).getTime();
    expect(formatDateTime(ts)).toBe('2024-01-02 05:06');
    expect(toDatetimeLocalValue(ts)).toBe('2024-01-02T05:06');
    expect(parseDatetimeLocalValue('2024-01-02T05:06')).toBe(ts);
  });

  it('normalizes titles', () => {
    expect(normalizeTitle('  Hello   World  ')).toBe('hello world');
  });

  it('generates random hex keys', () => {
    const key = randomKey(8);
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it('debounces function calls', () => {
    vi.useFakeTimers();
    const spy = vi.fn();
    const debounced = debounce(spy, 200);

    debounced('a');
    debounced('b');
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('b');
  });

  it('parses signaling list values', () => {
    expect(parseSignalingList(' ws1, ws2 ,,')).toEqual(['ws1', 'ws2']);
    expect(parseSignalingList('')).toEqual([]);
  });

  it('handles error serialization and redaction helpers', () => {
    const err = new Error('boom');
    const serialized = errToObj(err);
    expect(serialized.message).toBe('boom');
    expect(errToObj('oops')).toEqual({ message: 'oops' });
    expect(errToObj(null)).toBeNull();

    expect(redact('secret')).toBe('******');
    expect(redact('abcdefghijklmnopqrstuvwxyz', 4)).toBe('abcd...wxyz (len=26)');
  });

  it('serializes JSON-safe values', () => {
    expect(toJsonSafe({ a: 1 })).toEqual({ a: 1 });

    const circular = {};
    circular.self = circular;
    expect(toJsonSafe(circular)).toBe('[object Object]');
  });

  it('scores suggestions with recency and usage weighting', () => {
    const now = new Date(2024, 0, 2, 12, 0).getTime();
    const recent = {
      usageCount: 10,
      firstUsedAt: now - DAY_MS * 5,
      lastUsedAt: now - DAY_MS * 0.2,
      meanMinutes: minutesOfDay(now)
    };
    const older = {
      usageCount: 10,
      firstUsedAt: now - DAY_MS * 5,
      lastUsedAt: now - DAY_MS * 10,
      meanMinutes: minutesOfDay(now)
    };
    const lowUsage = {
      usageCount: 1,
      firstUsedAt: now - DAY_MS * 5,
      lastUsedAt: now - DAY_MS * 0.2,
      meanMinutes: minutesOfDay(now)
    };

    expect(suggestionScore(recent, 0.2, now)).toBeGreaterThan(suggestionScore(older, 0.2, now));
    expect(suggestionScore(recent, 0.2, now)).toBeGreaterThan(suggestionScore(lowUsage, 0.2, now));
  });

  it('escapes HTML entities', () => {
    expect(escapeHtml('<div class="x">&</div>')).toBe('&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;');
  });
});

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});
