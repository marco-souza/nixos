export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface Exec {
  run(
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; input?: string },
  ): Promise<ExecResult>
}

export const realExec: Exec = {
  async run(cmd, opts = {}) {
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.input === undefined ? 'ignore' : new TextEncoder().encode(opts.input),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  },
}
