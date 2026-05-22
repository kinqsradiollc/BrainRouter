"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getClient } from "../../lib/client";
import { useUsers } from "@brainrouter/hooks";
import { useAuth } from "../../components/AuthProvider";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";
import { EmptyState } from "../../components/EmptyState";
import { InfiniteScrollSentinel } from "../../components/InfiniteScrollSentinel";
import { motion, AnimatePresence } from "framer-motion";
import { PublicUserRecord } from "@brainrouter/types";

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05
    }
  }
};

const rowVariants = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { type: "spring", stiffness: 300, damping: 22 } },
  exit: { opacity: 0, x: -20, height: 0, padding: 0, transition: { duration: 0.2 } }
} as const;

export default function UsersPage() {
  const router = useRouter();
  const client = useMemo(() => getClient(), []);
  const { user } = useAuth();
  const { users, refresh, loadMore, hasMore, isFetchingMore, isLoading } = useUsers(client);
  const [resetKey, setResetKey] = useState<string | null>(null);
  const [meId, setMeId] = useState<string>("");
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PublicUserRecord | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ userId: "", displayName: "", isAdmin: false });
  const [error, setError] = useState("");

  async function loadMe() {
    try {
      const meData = await client.me();
      setMeId(meData.userId || "");
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => { void loadMe(); }, [client]);
  useEffect(() => {
    if (user && !user.isAdmin) router.replace("/overview");
  }, [router, user]);

  async function toggleStatus(user: PublicUserRecord) {
    if (user.userId === meId && user.status === "active") {
      return;
    }
    const next = user.status === "active" ? "disabled" : "active";
    await client.updateUserStatus(user.userId, next);
    await refresh();
  }

  async function doCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      await client.createUser({
        userId: createForm.userId.trim(),
        displayName: createForm.displayName.trim() || undefined,
        isAdmin: createForm.isAdmin,
      });
      setCreateForm({ userId: "", displayName: "", isAdmin: false });
      setCreateOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    }
  }

  async function doDeleteUser() {
    if (!deleteTarget) return;
    setError("");
    try {
      await client.deleteUser(deleteTarget.userId);
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  async function doResetKey(userId: string) {
    setResettingUserId(userId);
    try {
      const data = await client.resetUserApiKey(userId);
      setResetKey(data.apiKey || null);
    } catch (e) {
      console.error(e);
    } finally {
      setResettingUserId(null);
    }
  }

  return (
    <AuthGuard>
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ display: "flex", flexDirection: "column", gap: "28px" }}
      >
        {/* Title block */}
        <PageHeader 
          title="Users" 
          description="Administration console for user roles, statuses, and API access keys." 
        />

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <PremiumButton variant="primary" onClick={() => setCreateOpen(true)}>
            Create User
          </PremiumButton>
        </div>

        {/* Info Card */}
        <PremiumCard level={3} style={{ border: "1px solid rgba(174, 147, 87, 0.15)" }}>
          <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, color: "var(--color-pure-white)", fontWeight: 500 }}>
            Open Signup Subsystem Active
          </h3>
          <p style={{ margin: "6px 0 0 0", color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.5 }}>
            Signup is open to all users. Authenticated users generate their own local API keys directly from their Profile page. Admins can reset credentials or disable active accounts from this portal.
          </p>
        </PremiumCard>

        {/* Legend */}
        <div style={{ display: "flex", gap: "16px", padding: "12px 16px", background: "rgba(0,0,0,0.2)", borderRadius: "var(--radius-md)", border: "1px solid rgba(226,227,233,0.06)", alignItems: "center" }}>
          <span style={{ fontSize: "12px", color: "var(--color-silver-text)", fontWeight: 600 }}>Action Legend:</span>
          <div style={{ display: "flex", gap: "16px", fontSize: "12px", color: "var(--color-stone-text)" }}>
             <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
               Disable
             </span>
             <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
               Enable
             </span>
             <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-golden-accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
               Rotate Key
             </span>
             <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
               <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
               Delete
             </span>
          </div>
        </div>

        {/* Table Container */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th style={{ width: "120px", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <motion.tbody 
              variants={containerVariants}
              initial="hidden"
              animate="show"
            >
              <AnimatePresence mode="popLayout">
                {users.map((u) => (
                  <motion.tr 
                    key={u.userId}
                    variants={rowVariants}
                    exit="exit"
                    layout
                  >
                    <td style={{ fontWeight: 600, color: "var(--color-pure-white)", fontSize: "14px" }}>
                      {u.displayName || u.userId}
                      {u.userId === meId && (
                        <span style={{ marginLeft: "8px", fontSize: "10px", padding: "1px 6px", borderRadius: "3px", background: "rgba(226,227,233,0.08)", color: "var(--color-silver-text)" }}>
                          You
                        </span>
                      )}
                    </td>
                    <td style={{ color: "var(--color-porcelain-text)" }}>{u.email}</td>
                    <td>
                      <span className={u.isAdmin ? "badge-gold" : "badge"}>
                        {u.isAdmin ? "Admin" : "User"}
                      </span>
                    </td>
                    <td>
                      <span 
                        style={{ 
                          display: "inline-flex", 
                          alignItems: "center", 
                          gap: "6px",
                          fontSize: "12px",
                          fontWeight: 500,
                          color: u.status === "active" ? "#10b981" : "var(--color-ash-text)"
                        }}
                      >
                        <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: u.status === "active" ? "#10b981" : "var(--color-ash-text)", boxShadow: u.status === "active" ? "0 0 6px #10b981" : "none" }} />
                        {u.status}
                      </span>
                    </td>
                    <td style={{ color: "var(--color-silver-text)", fontSize: "13px" }}>
                      {new Date(u.createdAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "6px", justifyContent: "flex-end", alignItems: "center" }}>

                        {/* Toggle enable/disable */}
                        <button
                          onClick={() => toggleStatus(u)}
                          disabled={u.userId === meId}
                          title={u.userId === meId ? "Cannot disable yourself" : (u.status === "active" ? "Disable user" : "Enable user")}
                          style={{
                            width: "30px", height: "30px", borderRadius: "8px", border: "1px solid",
                            background: "transparent", cursor: u.userId === meId ? "default" : "pointer",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            opacity: u.userId === meId ? 0.35 : 1,
                            transition: "all 0.15s ease",
                            borderColor: u.status === "active" ? "rgba(239,68,68,0.35)" : "rgba(16,185,129,0.35)",
                            color: u.status === "active" ? "#f87171" : "#34d399",
                          }}
                        >
                          {u.status === "active" ? (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                            </svg>
                          ) : (
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="20 6 9 17 4 12"/>
                            </svg>
                          )}
                        </button>

                        {/* Reset API key */}
                        <button
                          onClick={() => doResetKey(u.userId)}
                          disabled={resettingUserId === u.userId}
                          title="Rotate the user's API key — their current key will stop working"
                          style={{
                            width: "30px", height: "30px", borderRadius: "8px",
                            border: "1px solid rgba(174,147,87,0.3)",
                            background: "transparent", cursor: resettingUserId === u.userId ? "default" : "pointer",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            opacity: resettingUserId === u.userId ? 0.4 : 1,
                            transition: "all 0.15s ease",
                            color: "var(--color-golden-accent)",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2v6h-6"/>
                            <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
                            <path d="M3 22v-6h6"/>
                            <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
                          </svg>
                        </button>

                        {/* Delete user */}
                        <button
                          onClick={() => setDeleteTarget(u)}
                          disabled={u.userId === meId}
                          title={u.userId === meId ? "Cannot delete yourself" : "Permanently delete this user"}
                          style={{
                            width: "30px", height: "30px", borderRadius: "8px",
                            border: "1px solid rgba(239,68,68,0.25)",
                            background: "transparent", cursor: u.userId === meId ? "default" : "pointer",
                            display: "inline-flex", alignItems: "center", justifyContent: "center",
                            opacity: u.userId === meId ? 0.35 : 1,
                            transition: "all 0.15s ease",
                            color: "#f87171",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6"/>
                            <path d="M19 6l-1 14H6L5 6"/>
                            <path d="M10 11v6"/><path d="M14 11v6"/>
                            <path d="M9 6V4h6v2"/>
                          </svg>
                        </button>

                      </div>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </motion.tbody>
          </table>
          <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
          {!isLoading && users.length === 0 && (
            <div style={{ padding: "28px" }}>
              <EmptyState title="No users found" description="Create the first managed user for this BrainRouter instance." />
            </div>
          )}
        </div>

        {error && (
          <div style={{ color: "#f87171", fontSize: "13px" }}>{error}</div>
        )}

        {/* Generated Key Modal */}
        <PremiumModal 
          isOpen={!!resetKey} 
          onClose={() => setResetKey(null)}
          title="Reset API Key Generated Successfully"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ margin: 0, color: "var(--color-stone-text)", fontSize: "14px", lineHeight: 1.5 }}>
              Copy the key below. It will only be shown once for security purposes.
            </p>
            <div style={{ display: "flex", gap: "10px", alignItems: "center", background: "rgba(0,0,0,0.2)", padding: "12px 16px", borderRadius: "var(--radius-md)", border: "1px solid rgba(226,227,233,0.06)" }}>
              <code style={{ flex: 1, wordBreak: "break-all", color: "var(--color-pure-white)", fontSize: "14px" }}>{resetKey}</code>
            </div>
            <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "8px" }}>
              <PremiumButton 
                variant="text" 
                onClick={() => setResetKey(null)}
              >
                Close
              </PremiumButton>
              <PremiumButton 
                variant="primary" 
                onClick={() => {
                  if (resetKey) {
                    navigator.clipboard.writeText(resetKey);
                    alert("Copied successfully!");
                  }
                }}
              >
                Copy Key
              </PremiumButton>
            </div>
          </div>
        </PremiumModal>

        <PremiumModal
          isOpen={createOpen}
          onClose={() => setCreateOpen(false)}
          title="Create User"
        >
          <form onSubmit={doCreateUser} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <input
              className="pill-input"
              value={createForm.userId}
              onChange={(event) => setCreateForm((current) => ({ ...current, userId: event.target.value }))}
              placeholder="userId"
              required
            />
            <input
              className="pill-input"
              value={createForm.displayName}
              onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="Display name"
            />
            <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-silver-text)", fontSize: "13px" }}>
              <input
                type="checkbox"
                checked={createForm.isAdmin}
                onChange={(event) => setCreateForm((current) => ({ ...current, isAdmin: event.target.checked }))}
                style={{ accentColor: "#cc9166" }}
              />
              Admin user
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <PremiumButton type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</PremiumButton>
              <PremiumButton type="submit" variant="primary">Create</PremiumButton>
            </div>
          </form>
        </PremiumModal>

        <PremiumModal
          isOpen={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          title="Delete User"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ margin: 0, color: "var(--color-stone-text)", fontSize: "14px", lineHeight: 1.5 }}>
              Delete {deleteTarget?.displayName || deleteTarget?.userId}? This removes their BrainRouter account.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <PremiumButton variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</PremiumButton>
              <PremiumButton variant="danger" onClick={doDeleteUser}>Delete</PremiumButton>
            </div>
          </div>
        </PremiumModal>
      </motion.div>
    </AuthGuard>
  );
}
