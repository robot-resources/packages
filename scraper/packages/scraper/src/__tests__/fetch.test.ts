import { describe, it, expect } from 'vitest';
import { FetchError } from '../fetch.js';

describe('FetchError', () => {
  it('creates error with message', () => {
    const error = new FetchError('Test error');

    expect(error.message).toBe('Test error');
    expect(error.name).toBe('FetchError');
    expect(error.statusCode).toBeUndefined();
    expect(error.retryable).toBe(false);
  });

  it('creates error with status code', () => {
    const error = new FetchError('Not found', 404, false);

    expect(error.statusCode).toBe(404);
    expect(error.retryable).toBe(false);
  });

  it('creates retryable error', () => {
    const error = new FetchError('Server error', 500, true);

    expect(error.statusCode).toBe(500);
    expect(error.retryable).toBe(true);
  });
});

// Note: fetchUrl tests would require mocking fetch
// which is out of scope for this basic test setup
// Integration tests should cover real HTTP scenarios
