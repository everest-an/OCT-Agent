import { ipcMain } from 'electron';
import { mapChannelHistory, mapChannelSessions } from './channel-session-transform';

export function registerChannelSessionHandlers(deps: {
  getGatewayWs: () => Promise<{
    sessionsList: () => Promise<{ sessions?: any[] } | any>;
    chatHistory: (sessionKey: string) => Promise<any[]>;
    chatSend: (sessionKey: string, text: string) => Promise<{ runId?: string } | any>;
  }>;
  toFrontendId: (openclawId: string) => string;
}) {
  ipcMain.handle('channel:sessions', async () => {
    try {
      const gw = await deps.getGatewayWs();
      const result = await gw.sessionsList();
      const sessions = result?.sessions || [];
      return { success: true, sessions: mapChannelSessions(sessions, deps.toFrontendId) };
    } catch (err: any) {
      return { success: false, sessions: [], error: err.message };
    }
  });

  ipcMain.handle('channel:history', async (_e, sessionKey: string) => {
    try {
      const gw = await deps.getGatewayWs();
      const result = await gw.chatHistory(sessionKey);
      return { success: true, messages: mapChannelHistory(result || []) };
    } catch (err: any) {
      return { success: false, messages: [], error: err.message };
    }
  });

  ipcMain.handle('channel:reply', async (_e, sessionKey: string, text: string) => {
    try {
      const gw = await deps.getGatewayWs();
      const result = await gw.chatSend(sessionKey, text);
      return { success: true, runId: result?.runId };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}