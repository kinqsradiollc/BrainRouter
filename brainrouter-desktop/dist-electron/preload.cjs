"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * DESK-1 — the renderer's ONLY capability surface (contextBridge). Typed in
 * src/bridge.d.ts; commands are re-validated in main before reaching the host.
 */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('brainrouter', {
    send(command) {
        ipcRenderer.send('agent-command', command);
    },
    onEvent(listener) {
        const wrapped = (_e, msg) => listener(msg);
        ipcRenderer.on('agent-event', wrapped);
        return () => ipcRenderer.removeListener('agent-event', wrapped);
    },
});
