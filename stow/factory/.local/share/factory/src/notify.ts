import type { Exec } from './exec'

const esc =(s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** Tells the human a job needs them. Every channel is best effort; never throws. */
export async function notify(
  n: { title: string; message: string },
  exec: Exec,
  platform: NodeJS.Platform = process.platform,
  write: (s: string) => unknown = (s) => process.stderr.write(s),
): Promise<void> {
  const attempt = async (fn: () => unknown) => {
    try {
      await fn()
    } catch {
      // a missing notifier must not break the driver
    }
  }
  if (platform === 'darwin') {
    await attempt(() =>
      exec.run(['osascript', '-e', `display notification "${esc(n.message)}" with title "${esc(n.title)}"`]),
    )
  } else if (platform === 'linux') {
    await attempt(() => exec.run(['notify-send', '--', n.title, n.message]))
  }
  await attempt(() => write('\x07'))
}
