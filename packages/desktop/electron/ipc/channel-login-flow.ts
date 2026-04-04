import { shell } from 'electron';
import { spawn } from 'child_process';
import os from 'os';

function isQrLine(line: string, stripAnsi: (value: string) => string): boolean {
  const clean = stripAnsi(line);
  if (clean.length < 4) return false;
  const blockCount = [...clean].filter((char) => '▄▀█░▒▓'.includes(char) || char === ' ').length;
  return blockCount / clean.length > 0.55;
}

export function createChannelLoginWithQR(deps: {
  getEnhancedPath: () => string;
  wrapWindowsCommand: (cmd: string) => string;
  stripAnsi: (value: string) => string;
  sendToRenderer: (channel: string, payload: unknown) => void;
}) {
  return function channelLoginWithQR(
    loginCmd: string,
    timeoutMs = 180000,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const ep = deps.getEnhancedPath();
    const windowsPathext = (typeof process.env.PATHEXT === 'string' && process.env.PATHEXT.trim())
      ? process.env.PATHEXT
      : '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
    const send = (channel: string, data: unknown) => {
      deps.sendToRenderer(channel, data);
    };

    return new Promise((resolve) => {
      let settled = false;
      let stdout = '';
      let lineBuffer = '';
      let qrShown = false;
      let qrLines: string[] = [];
      let lineCount = 0;
      let qrFlushTimer: NodeJS.Timeout | null = null;

      const child = process.platform === 'win32'
        ? spawn(deps.wrapWindowsCommand(loginCmd), [], {
            cwd: os.homedir(),
            shell: 'cmd.exe',
            env: {
              ...process.env,
              PATH: ep,
              PATHEXT: windowsPathext,
              ComSpec: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
              NO_COLOR: '1',
              FORCE_COLOR: '0',
            },
          })
        : spawn('/bin/bash', ['--norc', '--noprofile', '-c', `export PATH="${ep}"; ${loginCmd} 2>&1`]);

      let idleTimer: NodeJS.Timeout | null = null;
      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      const resetIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill(); } catch {}
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          if (qrShown) {
            resolve({ success: false, error: 'QR code expired. Click "Try again" to get a new QR code.' });
          } else {
            resolve({ success: false, error: 'Connection timed out while OpenClaw was still loading. Please retry in 20-60 seconds.' });
          }
        }, timeoutMs);
      };
      resetIdleTimer();

      const processLine = (line: string) => {
        resetIdleTimer();
        lineCount++;
        stdout += line + '\n';

        if (!qrShown) {
          if (line.includes('[plugins]') && line.includes('Registered')) {
            const pluginMatch = line.match(/\[plugins\]\s+(\S+?):/);
            send('channel:status', pluginMatch ? `channels.status.loadingPlugin::${pluginMatch[1]}` : 'channels.status.loadingPlugins');
          } else if (line.includes('Waiting for') || line.includes('Scan this QR')) {
            send('channel:status', 'channels.status.generatingQR');
          } else if (line.includes('auto-start')) {
            send('channel:status', 'channels.status.startingMemory');
          } else if (line.includes('plugin registered') || line.includes('plugin initialized')) {
            send('channel:status', 'channels.status.almostReady');
          }
        }

        if (!qrShown) {
          const httpsUrls = line.match(/https?:\/\/\S+/g) || [];
          for (const url of httpsUrls) {
            if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('docs.openclaw') || url.includes('github.com')) continue;
            qrShown = true;
            shell.openExternal(url);
            return;
          }
        }

        if (!qrShown) {
          const signalLink = line.match(/sgnl:\/\/\S+/);
          if (signalLink) {
            qrShown = true;
            shell.openExternal(signalLink[0]);
            return;
          }
        }

        if (isQrLine(line, deps.stripAnsi)) {
          qrLines.push(line);
          if (qrFlushTimer) clearTimeout(qrFlushTimer);
          qrFlushTimer = setTimeout(() => {
            if (qrLines.length >= 5 && !qrShown) {
              qrShown = true;
              send('channel:qr-art', qrLines.join('\n'));
            }
          }, 300);
        } else {
          if (qrFlushTimer) {
            clearTimeout(qrFlushTimer);
            qrFlushTimer = null;
          }
          if (qrLines.length >= 5 && !qrShown) {
            qrShown = true;
            send('channel:qr-art', qrLines.join('\n'));
          }
          qrLines = [];
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.stderr?.on('data', (data: Buffer) => {
        resetIdleTimer();
        const chunk = data.toString();
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) processLine(line);
      });

      child.on('exit', (code) => {
        if (lineBuffer) processLine(lineBuffer);
        if (settled) return;
        settled = true;
        clearIdleTimer();
        if (qrFlushTimer) {
          clearTimeout(qrFlushTimer);
          qrFlushTimer = null;
        }
        if (code === 0) {
          resolve({ success: true, output: 'Connected!' });
        } else if (qrShown) {
          resolve({ success: false, error: 'QR code expired. Click "Try again" to get a new QR code.' });
        } else {
          resolve({ success: false, error: stdout.slice(-300) || `Exit code ${code}` });
        }
      });

      child.on('error', (err) => {
        clearIdleTimer();
        if (qrFlushTimer) {
          clearTimeout(qrFlushTimer);
          qrFlushTimer = null;
        }
        if (settled) return;
        settled = true;
        resolve({ success: false, error: String(err).slice(0, 300) });
      });
    });
  };
}