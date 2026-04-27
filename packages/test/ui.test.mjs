import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prompt, confirm } = await import('../lib/ui.js');

describe('ui', () => {
  describe('prompt', () => {
    it('resolves immediately with default value in non-interactive mode', async () => {
      const result = await prompt('Enter API key', { nonInteractive: true, defaultValue: 'default-val' });

      expect(result).toBe('default-val');
    });

    it('resolves with empty string when non-interactive and no default', async () => {
      const result = await prompt('Enter something', { nonInteractive: true });

      expect(result).toBe('');
    });
  });

  describe('confirm', () => {
    it('resolves with true (defaultYes) in non-interactive mode', async () => {
      const result = await confirm('Proceed?', { nonInteractive: true });

      expect(result).toBe(true);
    });

    it('resolves with false when defaultYes=false in non-interactive mode', async () => {
      const result = await confirm('Are you sure?', { nonInteractive: true, defaultYes: false });

      expect(result).toBe(false);
    });
  });
});
