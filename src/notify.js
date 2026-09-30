// Desktop notifications, with no dependencies: a Windows toast through PowerShell,
// Notification Center through osascript on macOS, notify-send on Linux.

import { spawn } from 'node:child_process';

function run(cmd, args) {
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

const psString = (s) => "'" + String(s).replace(/'/g, "''") + "'";

export function notify(title, message) {
  if (process.env.REROUTE_NO_NOTIFY) return;
  if (process.platform === 'win32') {
    // Shows under PowerShell's app identity, which every Windows install has registered.
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
      `$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode(${psString(title)})) > $null`,
      `$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode(${psString(message)})) > $null`,
      "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))',
    ].join('; ');
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]);
  } else if (process.platform === 'darwin') {
    const q = (s) => '"' + String(s).replace(/["\\]/g, '\\$&') + '"';
    run('osascript', ['-e', `display notification ${q(message)} with title ${q(title)}`]);
  } else {
    run('notify-send', ['--app-name=Reroute', title, message]);
  }
}
