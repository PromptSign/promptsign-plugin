// The mod's hooks (hooks/register.ts): claude plugin test .
//
// The mod reaches the verifier only through $.process.run, so each test
// answers that call from memory with the verdict it needs. scripts/verify.mjs
// itself is covered by hook.test.mjs and napi.test.mjs.

import type { On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

type Run = { exitCode: number; stdout?: string; stderr?: string }

// Answers every verifier run with `answer(argv, stdin)` and keeps each run.
function verifier(on: On, answer: (argv: readonly string[], stdin: string) => Run) {
  const runs: { argv: readonly string[]; stdin: string }[] = []

  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    const run = answer(e.argv, stdin)

    runs.push({ argv: e.argv, stdin })
    return {
      value: {
        exitCode: run.exitCode,
        stdout: run.stdout ?? '',
        stderr: run.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return runs
}

// A `verify.mjs verdict` answer: each path's action from `actions`, else warn.
function verdictsOf(actions: Record<string, string>) {
  return (argv: readonly string[]): Run => ({
    exitCode: 0,
    stdout: JSON.stringify(
      argv.slice(argv.indexOf('verdict') + 1).map(path => ({
        path,
        action: actions[path] ?? 'warn',
        report: `${(actions[path] ?? 'warn').toUpperCase()}  ${path}`,
      })),
    ),
  })
}

const SKILL = { skill: 'demo:hello', text: 'Say hello.' }

describe('register', () => {
  test('a skill that verifies reaches the model as written', async ($, on) => {
    mock.env(on, {})
    on('skill.prompt', ($, e) => ({ text: e.text }))

    const runs = verifier(on, () => ({ exitCode: 0 }))
    const { text } = await $.skill.prompt(SKILL)

    expect(text).toBe('Say hello.')
    expect(runs).toHaveLength(1)
    expect(runs[0]?.argv.at(-1)).toMatch(/scripts\/verify\.mjs$/)
    expect(JSON.parse(runs[0]?.stdin ?? '{}')).toEqual({
      hook_event_name: 'PreToolUse',
      tool_name: 'Skill',
      tool_input: { skill: 'demo:hello' },
    })
  })

  test('a skill that fails verification reaches the model as a notice', async ($, on) => {
    mock.env(on, {})
    on('skill.prompt', ($, e) => ({ text: e.text }))
    verifier(on, () => ({
      exitCode: 2,
      stderr: 'PromptSign: signature verification FAILED for skill "demo:hello"\n    - error: modified: SKILL.md',
    }))

    const { text } = await $.skill.prompt(SKILL)

    expect(text).not.toContain('Say hello.')
    expect(text).toContain('PromptSign withheld the skill "demo:hello"')
    expect(text).toContain('modified: SKILL.md')
  })

  test('a broken verifier lets the skill through, unless strict', async ($, on) => {
    on('skill.prompt', ($, e) => ({ text: e.text }))
    verifier(on, () => ({ exitCode: 1, stderr: 'node: not found' }))

    mock.env(on, {})
    expect((await $.skill.prompt(SKILL)).text).toBe('Say hello.')
  })

  test('under strict a broken verifier withholds the skill', async ($, on) => {
    on('skill.prompt', ($, e) => ({ text: e.text }))
    verifier(on, () => ({ exitCode: 1, stderr: 'node: not found' }))
    mock.env(on, { PROMPTSIGN_STRICT: '1' })

    const { text } = await $.skill.prompt(SKILL)

    expect(text).toContain('PromptSign withheld the skill "demo:hello"')
    expect(text).toContain('The verifier failed')
  })

  test('a CLAUDE.md that fails verification is replaced by a notice', async ($, on) => {
    mock.env(on, {})
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))

    const runs = verifier(on, verdictsOf({ '/repo/CLAUDE.md': 'fail' }))
    const files = [
      { path: '/etc/claude/CLAUDE.md', kind: 'managed' as const, content: 'org policy' },
      { path: '/repo/CLAUDE.md', kind: 'project' as const, content: 'tampered' },
      { path: '/home/me/.claude/CLAUDE.md', kind: 'user' as const, content: 'mine' },
    ]
    const context = await $.prompt.context({
      blocks: [{ name: 'claudeMd', text: 'x' }],
      instructionFiles: files,
    })
    const contents = context.instructionFiles?.map(file => file.content) ?? []

    expect(contents[0]).toBe('org policy')
    expect(contents[1]).toContain('PromptSign withheld /repo/CLAUDE.md')
    expect(contents[1]).not.toContain('tampered')
    expect(contents[2]).toBe('mine')
    expect(runs[0]?.argv.slice(-2), 'managed files are not sent to the verifier').toEqual([
      '/repo/CLAUDE.md',
      '/home/me/.claude/CLAUDE.md',
    ])
  })

  test('unsigned instruction files are left alone', async ($, on) => {
    mock.env(on, { PROMPTSIGN_STRICT: '1' })
    on('prompt.context', ($, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
    verifier(on, verdictsOf({}))

    const files = [{ path: '/repo/CLAUDE.md', kind: 'project' as const, content: 'plain' }]
    const context = await $.prompt.context({ blocks: [], instructionFiles: files })

    expect(context.instructionFiles).toEqual(files)
  })

  test(
    'a hooks module that fails verification is refused',
    { plugins: [{ name: 'tampered', register(on) { on('session.start', ($, e, next) => next(e)) } }] },
    async ($, on) => {
      mock.env(on, {})
      on('session.start', ($, e) => ({ cwd: e.cwd }))

      const runs = verifier(on, argv => verdictsOf({ [argv.at(-1) ?? '']: 'fail' })(argv))

      await expect($.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })).rejects.toThrow(
        /tampered failed signature verification/,
      )
      expect(runs).toHaveLength(1)
    },
  )

  test(
    'a hooks module that verifies loads',
    { plugins: [{ name: 'fine', register(on) { on('session.start', ($, e, next) => next(e)) } }] },
    async ($, on) => {
      mock.env(on, {})
      on('session.start', ($, e) => ({ cwd: e.cwd }))
      verifier(on, verdictsOf({}))

      await expect(
        $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' }),
      ).resolves.toBeDefined()
    },
  )
})
