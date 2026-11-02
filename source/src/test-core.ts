/**
 * Test entry — exports the obsidian-free core so the test harness can run
 * the real SSH server + sandboxed shell in plain Node.js.
 */

export { VaultSSHServer } from './ssh-server';
export { VaultFS, VaultError } from './vaultfs';
export { generateHostKeys, hostKeyFingerprint } from './hostkeys';
export { DEFAULT_SETTINGS, DEFAULT_RULES_TEXT } from './types';
export { ShellSession, PLUGIN_VERSION } from './shell';
export type { VaultSSHSettings } from './types';
