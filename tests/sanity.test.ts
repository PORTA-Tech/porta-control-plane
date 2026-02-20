import { describe, expect, it } from 'vitest';
import { isMonotonicSequence } from '@porta/api-contracts';

describe('sanity', () => {
  it('checks monotonic sequences', () => {
    expect(isMonotonicSequence(2, 1)).toBe(true);
    expect(isMonotonicSequence(1, 1)).toBe(false);
  });
});
