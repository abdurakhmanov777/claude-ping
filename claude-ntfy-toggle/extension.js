const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

// The Stop hook in ~/.claude/settings.json just touches this file when a
// Claude Code request finishes. All ntfy logic lives here in the extension.
const claudeDir = path.join(os.homedir(), '.claude');
const triggerName = '.ntfy-trigger';
const triggerPath = path.join(claudeDir, triggerName);

function cfg() {
  return vscode.workspace.getConfiguration('claudeNtfy');
}

function isEnabled() {
  return cfg().get('enabled', true);
}

function render(item) {
  if (isEnabled()) {
    item.text = '$(bell) Claude';
    item.tooltip = 'Уведомления на телефон включены. Нажмите, чтобы выключить.';
    item.color = undefined;
  } else {
    item.text = '$(bell-slash) Claude';
    item.tooltip = 'Уведомления на телефон выключены. Нажмите, чтобы включить.';
    item.color = new vscode.ThemeColor('disabledForeground');
  }
}

// Publish via ntfy's JSON endpoint (POST to the server root with a JSON body).
// JSON body is UTF-8, so both title and message keep Cyrillic intact - no
// HTTP-header encoding issues, no curl.
function sendNotification() {
  const c = cfg();
  const topic = String(c.get('topic', '') || '').trim();
  if (!topic) {
    return;
  }
  let server = String(c.get('server', 'https://ntfy.sh') || 'https://ntfy.sh').trim();
  if (!/\/$/.test(server)) {
    server += '/';
  }

  let url;
  try {
    url = new URL(server);
  } catch (e) {
    return;
  }

  const payload = JSON.stringify({
    topic: topic,
    title: String(c.get('title', 'Claude Code') || ''),
    message: String(c.get('message', 'Запрос в Claude Code завершён') || ''),
  });
  const body = Buffer.from(payload, 'utf8');
  const mod = url.protocol === 'http:' ? http : https;
  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'http:' ? 80 : 443),
    path: url.pathname || '/',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
    },
  };

  const req = mod.request(options, function (res) {
    res.resume();
  });
  req.on('error', function () { /* offline / DNS - stay silent */ });
  req.write(body);
  req.end();
}

// Exactly-once across multiple VS Code windows: the first extension instance to
// atomically rename the trigger away "wins" and sends; the others' rename fails.
function handleTrigger() {
  const claim =
    triggerPath + '.claim-' + process.pid + '-' + Math.random().toString(36).slice(2);
  try {
    fs.renameSync(triggerPath, claim);
  } catch (e) {
    return; // already claimed by another window, or gone
  }
  try {
    fs.unlinkSync(claim);
  } catch (e) { /* ignore */ }
  if (isEnabled()) {
    sendNotification();
  }
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  item.command = 'claudeNtfy.toggle';
  render(item);
  item.show();
  context.subscriptions.push(item);

  // Drop any stale trigger left over from a session when no window was open.
  try {
    fs.unlinkSync(triggerPath);
  } catch (e) { /* nothing to clean */ }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNtfy.toggle', async function () {
      const c = cfg();
      const now = c.get('enabled', true);
      await c.update('enabled', !now, vscode.ConfigurationTarget.Global);
      render(item);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNtfy.test', function () {
      const topic = String(cfg().get('topic', '') || '').trim();
      if (!topic) {
        vscode.window.showWarningMessage(
          'Claude ntfy: задайте топик в настройках (claudeNtfy.topic), тогда уведомления заработают.'
        );
        return;
      }
      sendNotification();
      vscode.window.setStatusBarMessage('Claude ntfy: тестовое уведомление отправлено', 3000);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(function (e) {
      if (e.affectsConfiguration('claudeNtfy')) {
        render(item);
      }
    })
  );

  // Watch ~/.claude for the trigger file the Stop hook touches.
  try {
    const watcher = fs.watch(claudeDir, function (eventType, filename) {
      if (filename === triggerName) {
        handleTrigger();
      }
    });
    context.subscriptions.push({ dispose: function () { watcher.close(); } });
  } catch (e) { /* directory missing - nothing to watch */ }
}

function deactivate() {}

module.exports = { activate, deactivate };
