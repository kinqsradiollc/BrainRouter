"use client";

import { useEffect, useMemo, useState } from "react";
import { getClient } from "../../lib/client";
import { useUsers } from "@brainrouter/hooks";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { PremiumCard } from "../../components/PremiumCard";
import { PremiumButton } from "../../components/PremiumButton";
import { PremiumModal } from "../../components/PremiumModal";
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
  const client = useMemo(() => getClient(), []);
  const { users, refresh, loadMore, hasMore, isFetchingMore } = useUsers(client);
  const [resetKey, setResetKey] = useState<string | null>(null);
  const [meId, setMeId] = useState<string>("");
  const [resettingUserId, setResettingUserId] = useState<string | null>(null);

  async function loadMe() {
    try {
      const meData = await client.me();
      setMeId(meData.userId || "");
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => { void loadMe(); }, [client]);

  async function toggleStatus(user: PublicUserRecord) {
    if (user.userId === meId && user.status === "active") {
      alert("You cannot disable your own account");
      return;
    }
    const next = user.status === "active" ? "disabled" : "active";
    await client.updateUserStatus(user.userId, next);
    await refresh();
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

        {/* Info Card */}
        <PremiumCard level={3} style={{ border: "1px solid rgba(174, 147, 87, 0.15)" }}>
          <h3 className="serif-display" style={{ fontSize: "18px", margin: 0, color: "var(--color-pure-white)", fontWeight: 500 }}>
            Open Signup Subsystem Active
          </h3>
          <p style={{ margin: "6px 0 0 0", color: "var(--color-stone-text)", fontSize: "13px", lineHeight: 1.5 }}>
            Signup is open to all users. Authenticated users generate their own local API keys directly from their Profile page. Admins can reset credentials or disable active accounts from this portal.
          </p>
        </PremiumCard>

        {/* Table Container */}
        <div className="table-container">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th style={{ width: "240px", textAlign: "right" }}>Actions</th>
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
                    <td style={{ textAlign: "right" }}>
                      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                        <PremiumButton 
                          variant={u.status === "active" ? "danger" : "success"}
                          style={{ padding: "6px 14px", fontSize: "12px", height: "32px" }}
                          onClick={() => toggleStatus(u)}
                          disabled={u.userId === meId}
                        >
                          {u.status === "active" ? "Disable" : "Enable"}
                        </PremiumButton>
                        <PremiumButton 
                          variant="ghost"
                          style={{ padding: "6px 14px", fontSize: "12px", height: "32px" }}
                          onClick={() => doResetKey(u.userId)}
                          disabled={resettingUserId === u.userId}
                        >
                          {resettingUserId === u.userId ? "Resetting..." : "Reset Key"}
                        </PremiumButton>
                      </div>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </motion.tbody>
          </table>
          <InfiniteScrollSentinel hasMore={hasMore} isFetchingMore={isFetchingMore} onLoadMore={loadMore} />
        </div>

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
      </motion.div>
    </AuthGuard>
  );
}
