import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentConfig } from '../src/config.js';

describe('loadAgentConfig shared secret', () => {
  it('reads AGENT_SHARED_SECRET from the environment', () => {
    expect(loadAgentConfig({ AGENT_SHARED_SECRET: 'env-secret' }).sharedSecret).toBe('env-secret');
  });

  it('reads and trims the file named by AGENT_SHARED_SECRET_FILE', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-config-')), 'secret');
    writeFileSync(file, 'file-secret\n');
    expect(loadAgentConfig({ AGENT_SHARED_SECRET_FILE: file }).sharedSecret).toBe('file-secret');
  });

  it('rejects both, neither, and an empty file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'agent-config-')), 'secret');
    writeFileSync(file, '\n');
    expect(() => loadAgentConfig({ AGENT_SHARED_SECRET: 'a', AGENT_SHARED_SECRET_FILE: file })).toThrow(/not both/);
    expect(() => loadAgentConfig({})).toThrow(/required/);
    expect(() => loadAgentConfig({ AGENT_SHARED_SECRET_FILE: file })).toThrow(/required/);
  });
});
