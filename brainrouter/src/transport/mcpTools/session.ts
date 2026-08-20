// ADR-041 A41-7 — the final McpToolRegistry slice: the session_* messaging tools.
// Unlike the other families these close over the per-connection delivery hub, the
// connection claim, and the server notifier, so they read five session fields off
// ctx.host (connectionId, sessionDeliveryHub, authorizeOwnedSession,
// validateDeliveryClaim, sessionNotify). Every closure below is the mcpServer.ts
// switch case verbatim, with `options.*`/`server.notification` swapped for the
// host members mcpServer.ts marshalled from exactly those values.
import {
  handleSessionRegister,
  handleSessionHeartbeat,
  handleSessionUnregister,
  handleSessionList,
  handleSessionSend,
  handleSessionInboxRead,
  handleSessionInboxAck,
  handleSessionReceipts,
  handleSessionReceiptsAck,
  handleSessionDelegateTask,
  handleSessionDelegations,
} from '../../tools/sessions/index.js';
import { registerMcpTool } from './registry.js';

registerMcpTool('session_register', (ctx) => {
  const { connectionId, sessionDeliveryHub } = ctx.host;
  return handleSessionRegister(ctx.args, {
    defaultUserId: ctx.host.defaultUserId,
    defaultOrgId: ctx.host.defaultOrgId,
    claimToken: connectionId,
    onRegistered: sessionDeliveryHub && connectionId
      ? (orgId, userId, sessionKey, messageWakeVersion, registrationAttemptId) => {
          const committed = sessionDeliveryHub.commitReservation({
            connectionId,
            orgId,
            userId,
            sessionKey,
            ...(messageWakeVersion === 1
              ? { notify: (wake) => ctx.host.sessionNotify(wake) }
              : {}),
          }, registrationAttemptId);
          if (!committed) {
            throw new Error('the session registration reservation is no longer current');
          }
        }
      : undefined,
    authorizeRegistration: sessionDeliveryHub && connectionId
      ? (orgId, userId, sessionKey, registrationAttemptId) => sessionDeliveryHub.reserve(
          connectionId,
          orgId,
          userId,
          sessionKey,
          registrationAttemptId,
        )
      : undefined,
    onRegistrationFailed: sessionDeliveryHub && connectionId
      ? (orgId, userId, sessionKey, registrationAttemptId) => sessionDeliveryHub.releaseReservation(
          connectionId,
          orgId,
          userId,
          sessionKey,
          registrationAttemptId,
        )
      : undefined,
  });
});

registerMcpTool('session_heartbeat', (ctx) => handleSessionHeartbeat(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
  claimToken: ctx.host.connectionId,
  authorizeSession: ctx.host.authorizeOwnedSession,
}));

registerMcpTool('session_unregister', (ctx) => {
  const { connectionId, sessionDeliveryHub } = ctx.host;
  return handleSessionUnregister(ctx.args, {
    defaultUserId: ctx.host.defaultUserId,
    defaultOrgId: ctx.host.defaultOrgId,
    claimToken: connectionId,
    onUnregistered: sessionDeliveryHub && connectionId
      ? (orgId, userId, sessionKey) => sessionDeliveryHub.unbind(
          orgId,
          userId,
          sessionKey,
          connectionId,
        )
      : undefined,
    authorizeSession: ctx.host.authorizeOwnedSession,
  });
});

registerMcpTool('session_list', (ctx) => handleSessionList(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
}));

registerMcpTool('session_send', (ctx) => {
  const { sessionDeliveryHub, validateDeliveryClaim } = ctx.host;
  return handleSessionSend(ctx.args, {
    defaultUserId: ctx.host.defaultUserId,
    defaultOrgId: ctx.host.defaultOrgId,
    claimToken: ctx.host.connectionId,
    onPersisted: sessionDeliveryHub
      ? (rows) => sessionDeliveryHub.notifyPersisted(rows, validateDeliveryClaim)
      : undefined,
    authorizeSession: ctx.host.authorizeOwnedSession,
  });
});

registerMcpTool('session_inbox_read', (ctx) => handleSessionInboxRead(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
  claimToken: ctx.host.connectionId,
  authorizeSession: ctx.host.authorizeOwnedSession,
}));

registerMcpTool('session_inbox_ack', (ctx) => handleSessionInboxAck(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
  claimToken: ctx.host.connectionId,
  authorizeSession: ctx.host.authorizeOwnedSession,
}));

registerMcpTool('session_receipts', (ctx) => handleSessionReceipts(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
  claimToken: ctx.host.connectionId,
  authorizeSession: ctx.host.authorizeOwnedSession,
}));

registerMcpTool('session_receipts_ack', (ctx) => handleSessionReceiptsAck(ctx.args, {
  defaultUserId: ctx.host.defaultUserId,
  defaultOrgId: ctx.host.defaultOrgId,
  claimToken: ctx.host.connectionId,
  authorizeSession: ctx.host.authorizeOwnedSession,
}));

registerMcpTool('session_delegate_task', (ctx) =>
  handleSessionDelegateTask(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
registerMcpTool('session_delegations', (ctx) =>
  handleSessionDelegations(ctx.args, { defaultUserId: ctx.host.defaultUserId }));
