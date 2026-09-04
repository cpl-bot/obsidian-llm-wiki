import { describe, it, expect, afterEach } from 'vitest';
import {
  UPSTREAM_PLUGIN_ID,
  getActivePluginId,
  setActivePluginId,
  resetActivePluginIdForTests,
} from '../../core/plugin-runtime-id';

describe('plugin-runtime-id', () => {
  afterEach(() => {
    // Module state is process-lifetime; never let one test's id leak into
    // the next (this file's own tests, or another file in the same worker).
    resetActivePluginIdForTests();
  });

  it('defaults to the upstream plugin id before any onload has run', () => {
    expect(getActivePluginId()).toBe('karpathywiki');
    expect(getActivePluginId()).toBe(UPSTREAM_PLUGIN_ID);
  });

  it('reflects the id set from manifest.id, e.g. the hardened install id', () => {
    setActivePluginId('karpathywiki-hardened');
    expect(getActivePluginId()).toBe('karpathywiki-hardened');
  });

  it('resetActivePluginIdForTests restores the upstream default', () => {
    setActivePluginId('some-other-id');
    expect(getActivePluginId()).toBe('some-other-id');
    resetActivePluginIdForTests();
    expect(getActivePluginId()).toBe(UPSTREAM_PLUGIN_ID);
  });
});
