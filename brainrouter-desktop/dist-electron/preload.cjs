"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * DESK-3b — the renderer's ONLY capability surface. Agent protocol on one
 * channel; workspace management (main-process dialogs) on invoke channels.
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
    addWorkspace() {
        return ipcRenderer.invoke('workspace:add');
    },
    workspaceRecents() {
        return ipcRenderer.invoke('workspace:recents');
    },
    openWorkspace(workspaceRoot) {
        return ipcRenderer.invoke('workspace:open', workspaceRoot);
    },
    // T1 — workspace trust, backed by the shared CLI store (not localStorage).
    isWorkspaceTrusted(workspaceRoot) {
        return ipcRenderer.invoke('workspace:isTrusted', workspaceRoot);
    },
    trustWorkspace(workspaceRoot) {
        return ipcRenderer.invoke('workspace:trust', workspaceRoot);
    },
    untrustWorkspace(workspaceRoot) {
        return ipcRenderer.invoke('workspace:untrust', workspaceRoot);
    },
    trustedWorkspaces() {
        return ipcRenderer.invoke('workspace:trustedList');
    },
});
