// "New agents were installed" detection: only a Bash command that actually RUNS
// install.sh with --pack means it. Grep/sed/echo commands that merely mention
// `install.sh` or `--pack` (docs lookups, audits) must not trigger the banner.

/** Segment boundaries of a compound shell command. */
const SEGMENT_SPLIT = /&&|\|\||[;|]|\r?\n/;
/** Optional command wrappers allowed before the install script itself. */
const WRAPPERS = new Set(['sudo', 'bash', 'sh', 'env']);
/** VAR=value environment assignments (with or without a leading `env`). */
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * True when any segment of the command runs the packs installer: the segment's first
 * word (after optional `env VAR=...`, `bash`, `sh` or `sudo` prefixes) is a path ending
 * in `install.sh`, the segment carries a `--pack` argument, and no `--uninstall`.
 */
export function runsPackInstall(command: string): boolean {
  if (!command) return false;
  for (const segment of command.split(SEGMENT_SPLIT)) {
    const words = segment.trim().split(/\s+/);
    if (words[0] === undefined || words[0] === '') continue;
    // Skip optional wrappers (env, sudo, bash, sh) and env assignments before the program.
    let i = 0;
    while (i < words.length) {
      const w = words[i];
      if (WRAPPERS.has(w)) {
        i++;
        if (w !== 'env') continue;
        while (i < words.length && VAR_ASSIGN.test(words[i])) i++;
        continue;
      }
      if (VAR_ASSIGN.test(w)) {
        i++;
        continue;
      }
      break;
    }
    const program = words[i];
    if (!program || !isInstallShPath(program)) continue;
    const args = words.slice(i + 1);
    if (!args.some((w) => w === '--pack' || w.startsWith('--pack='))) continue;
    if (args.some((w) => w === '--uninstall' || w.startsWith('--uninstall='))) continue;
    return true;
  }
  return false;
}

/** The program word: bare `install.sh` (found via PATH) or any path ending in it. */
function isInstallShPath(word: string): boolean {
  return word === 'install.sh' || word.endsWith('/install.sh');
}
