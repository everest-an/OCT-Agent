import { ipcMain } from 'electron';
import { previewFile, selectDirectory, selectFile } from '../file-dialogs';

export function registerFileDialogHandlers() {
  ipcMain.handle('file:preview', async (_e, filePath: string) => {
    return previewFile(filePath);
  });

  ipcMain.handle('file:select', async (_e: any, options?: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    return selectFile(options);
  });

  ipcMain.handle('directory:select', async () => {
    return selectDirectory();
  });
}