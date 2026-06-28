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
    // User-controlled project ordering: main pushes updated recents for activity
    // membership changes and explicit drag/drop reorders.
    onRecentsChanged(listener) {
        const wrapped = (_e, data) => listener(data);
        ipcRenderer.on('recents-changed', wrapped);
        return () => ipcRenderer.removeListener('recents-changed', wrapped);
    },
    addWorkspace() {
        return ipcRenderer.invoke('workspace:add');
    },
    workspaceRecents() {
        return ipcRenderer.invoke('workspace:recents');
    },
    workspaceSessions(root, limit) {
        return ipcRenderer.invoke('workspace:sessions', root, limit);
    },
    openWorkspace(workspaceRoot) {
        return ipcRenderer.invoke('workspace:open', workspaceRoot);
    },
    // Open a workspace in a SEPARATE window (git worktrees) — never swaps the
    // current window's active workspace / projects / chat.
    openWorkspaceWindow(workspaceRoot) {
        return ipcRenderer.invoke('workspace:open-window', workspaceRoot);
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
    markActivity(workspaceRoot, reason) {
        return ipcRenderer.invoke('workspace:activity', workspaceRoot, reason);
    },
    reorderWorkspace(dragged, target) {
        return ipcRenderer.invoke('workspace:reorder', dragged, target);
    },
    // T1 — cross-workspace dashboard (running tasks + last review gate per recent root).
    globalDashboard() {
        return ipcRenderer.invoke('dashboard:global');
    },
});
