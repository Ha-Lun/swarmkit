import { describe, expect, it } from 'vitest';
import { runsPackInstall } from '../src/client/packInstall';

describe('runsPackInstall', () => {
  it('matches a command that actually runs install.sh with --pack', () => {
    expect(runsPackInstall('./install.sh --pack web /p')).toBe(true);
    expect(runsPackInstall('/home/x/opencode-config/install.sh --pack web /p')).toBe(true);
    expect(runsPackInstall('cd r && ./install.sh --pack web .')).toBe(true);
    // Wrappers and bare PATH lookups still count.
    expect(runsPackInstall('sudo bash /opt/x/install.sh --pack web')).toBe(true);
    expect(runsPackInstall('env FOO=1 sudo ./install.sh --pack=web')).toBe(true);
    expect(runsPackInstall('install.sh --pack web')).toBe(true);
  });

  it('matches only the installing segment of a compound command', () => {
    expect(runsPackInstall('./install.sh --pack web || echo fallback')).toBe(true);
    expect(runsPackInstall('echo looking; ./install.sh --pack web; echo done')).toBe(true);
  });

  it('ignores commands that merely mention install.sh or --pack', () => {
    expect(runsPackInstall('grep -rn -- "--pack" core/ | grep install.sh')).toBe(false);
    expect(runsPackInstall('grep -n "install.sh --pack" README.md')).toBe(false);
    expect(runsPackInstall("sed -n 's/install.sh --pack/gp' notes.txt")).toBe(false);
    expect(runsPackInstall('echo "run install.sh --pack me"')).toBe(false);
    expect(runsPackInstall('./install.sh --pack web || grep install.sh notes')).toBe(true);
  });

  it('does not count uninstall runs', () => {
    expect(runsPackInstall('./install.sh --uninstall --pack web /p')).toBe(false);
    expect(runsPackInstall('cd r && ./install.sh --uninstall web .')).toBe(false);
  });

  it('rejects empty and unrelated commands', () => {
    expect(runsPackInstall('')).toBe(false);
    expect(runsPackInstall('npm test')).toBe(false);
    expect(runsPackInstall('bash ./setup.sh --pack web')).toBe(false);
  });
});
