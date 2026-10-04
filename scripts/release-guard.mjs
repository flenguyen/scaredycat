/**
 * Claude Code PreToolUse hook (registered in .claude/settings.json, matcher
 * "Bash"): stops a `git commit` that changes what ships without a release note.
 *
 * Reads the hook payload from stdin ({ tool_input: { command } }). Exit 0 lets
 * the command run; exit 2 blocks it and Claude Code hands stderr back to
 * Claude. Any unexpected error fails open (exit 0): this is a reminder, not a
 * lock, and it must never wedge an unrelated command.
 *
 * Blocks when:
 *   - runtime files are staged, data/releases.json is not, and the command
 *     doesn't contain [no-release]; or
 *   - data/releases.json is staged and the release check fails on the staged
 *     (index) versions of the files.
 */

import { execFileSync } from 'node:child_process';
import { runReleaseCheck, RELEASES_PATH } from './release-check.mjs';

const RUNTIME = [/^manifest\.json$/, /^background(\.js$|\/)/, /^content\//, /^popup\//, /^offscreen\//, /^styles\//, /^fonts\//, /^icons\//];
const GIT_COMMIT = /\bgit\b(?:\s+-[cC]\s+\S+|\s+--[\w-]+(?:=\S+)?)*\s+commit\b/;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function block(message) {
  process.stderr.write(message.trim() + '\n');
  process.exit(2);
}

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const command = String(input?.tool_input?.command || '');
  if (!GIT_COMMIT.test(command)) process.exit(0);

  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  const staged = new Set(git('diff', '--cached', '--name-only').split('\n').filter(Boolean));
  // `git commit -a` / `--all` also takes every modified tracked file.
  const takesAll = /\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$)/.test(command.slice(command.search(GIT_COMMIT)));
  if (takesAll) git('diff', '--name-only').split('\n').filter(Boolean).forEach(f => staged.add(f));

  const runtime = [...staged].filter(f => RUNTIME.some(re => re.test(f)));
  const notesStaged = staged.has(RELEASES_PATH);

  if (runtime.length && !notesStaged && !command.includes('[no-release]')) {
    const list = runtime.slice(0, 8).join(', ') + (runtime.length > 8 ? `, and ${runtime.length - 8} more` : '');
    block(`
Release guard: this commit changes files that ship in the extension (${list}) but data/releases.json is not staged.

Classify the change using CLAUDE.md "Releases":
- Level 1 (a change to the deal: new data leaving the device or a new destination, a new permission, a higher minimum Chrome, a removed feature or changed default, a new platform/accounts/pricing, a detection rebuild): STOP and ask the user before committing. Explain the trigger and draft the note.
- Level 2 (something new to see or use) or Level 3 (fixes, speed, polish): bump the version in manifest.json and package.json, add or extend the entry at the top of data/releases.json, run npm run release:check, and stage all of it in this same commit.
- Nothing user-visible changed (tests, tooling, docs, comments only): add [no-release] to the commit message.
`);
  }

  if (notesStaged) {
    // Check what is about to be committed, not the working tree.
    const read = (rel) => {
      try { return git('show', `:${rel}`); }
      catch { return git('show', `HEAD:${rel}`); }
    };
    const errors = runReleaseCheck({ read });
    if (errors.length) {
      block(`Release guard: the staged release notes fail the release check:\n${errors.map(e => `  - ${e}`).join('\n')}\nFix them (see CLAUDE.md "Releases"), re-stage, and commit again.`);
    }
  }

  process.exit(0);
} catch {
  process.exit(0); // fail open
}
