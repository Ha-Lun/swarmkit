// Landing helpers: the shortened folder under the box and the shift+tab setup cycle.
import { describe, expect, it } from 'vitest';
import { shortFolder } from '../src/client/Landing.tsx';
import { nextSetup } from '../src/client/StartForm.tsx';

describe('shortFolder', () => {
  it('shows home as ~ and keeps short paths whole', () => {
    expect(shortFolder('', '/home/ha')).toBe('~');
    expect(shortFolder('/home/ha', '/home/ha')).toBe('~');
    expect(shortFolder('/home/ha/code', '/home/ha')).toBe('~/code');
    expect(shortFolder('/home/ha/code/app', '/home/ha')).toBe('~/code/app');
  });
  it('cuts long paths to the last two segments', () => {
    expect(shortFolder('/home/ha/work/clients/acme/web', '/home/ha')).toBe('~/…/acme/web');
  });
  it('leaves paths outside home absolute', () => {
    expect(shortFolder('/srv/app', '/home/ha')).toBe('/srv/app');
    expect(shortFolder('/srv/a/b/c', '/home/ha')).toBe('/…/b/c');
    // a sibling folder that merely shares the prefix is not under home
    expect(shortFolder('/home/hamster/x', '/home/ha')).toBe('/…/hamster/x');
  });
  it('works before home is known', () => {
    expect(shortFolder('/home/ha/code', '')).toBe('/…/ha/code');
  });
});

describe('nextSetup', () => {
  it('cycles claude, opencode, agy', () => {
    expect(nextSetup('claude', null)).toBe('opencode');
    expect(nextSetup('opencode', null)).toBe('agy');
    expect(nextSetup('agy', null)).toBe('claude');
  });
  it('skips setups that are not on PATH', () => {
    expect(nextSetup('claude', { claude: true, opencode: false, agy: true })).toBe('agy');
    expect(nextSetup('agy', { claude: true, opencode: false, agy: true })).toBe('claude');
  });
  it('stays put when it is the only one installed', () => {
    expect(nextSetup('claude', { claude: true, opencode: false, agy: false })).toBe('claude');
  });
});
