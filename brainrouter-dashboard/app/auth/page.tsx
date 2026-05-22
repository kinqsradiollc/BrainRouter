"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { getClient } from "../../lib/client";
import { useAuth } from "../../components/AuthProvider";
import { PremiumButton } from "../../components/PremiumButton";

type Mode = "signin" | "signup";

export default function AuthPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [signin, setSignin] = useState({ email: "", password: "" });
  const [rememberMe, setRememberMe] = useState(false);
  const [signup, setSignup] = useState({ email: "", displayName: "", password: "", confirmPassword: "" });

  // Light beam and 3D tilt interaction states
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCoords({ x, y });

    // Calculate normalized coordinates (-1 to 1) for 3D tilt
    const normX = (x / rect.width) * 2 - 1;
    const normY = (y / rect.height) * 2 - 1;
    setTilt({
      x: -normY * 6, // Max 6 degrees Y tilt
      y: normX * 6   // Max 6 degrees X tilt
    });
  }

  function handleMouseLeave() {
    setIsHovered(false);
    setTilt({ x: 0, y: 0 });
  }

  function authErrorMessage(err: unknown) {
    const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status?: number }).status) : 0;
    if (status === 409) return "This email is already registered. Try signing in.";
    if (status === 401) return "Incorrect email or password.";
    if (status === 403) return "Your account has been disabled. Contact an administrator.";
    if (err instanceof TypeError) return "Cannot reach the server. Is the MCP server running?";
    return err instanceof Error ? err.message : "Something went wrong.";
  }

  function passwordStrength(password: string) {
    const hasMixedCase = /[a-z]/.test(password) && /[A-Z]/.test(password);
    const hasSpecial = /[^a-zA-Z0-9]/.test(password);
    if (password.length > 12 && hasMixedCase && hasSpecial) return { label: "Strong", color: "#22c55e", width: "100%" };
    if (password.length >= 8 && hasMixedCase) return { label: "OK", color: "#f59e0b", width: "66%" };
    return { label: "Weak", color: "#ef4444", width: "33%" };
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const client = getClient();
      const data = await client.signIn(signin);
      await login(data.jwt, data.apiKey, rememberMe);
      router.replace("/overview");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      if (signup.password !== signup.confirmPassword) throw new Error("Passwords do not match");
      const client = getClient();
      const data = await client.signUp({
        email: signup.email,
        password: signup.password,
        displayName: signup.displayName || undefined,
      });
      await login(data.jwt);
      router.replace("/overview");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ 
      minHeight: "calc(100vh - 120px)", 
      display: "flex", 
      alignItems: "center", 
      justifyContent: "center",
      position: "relative",
      padding: "40px 0 60px 0"
    }}>
      {/* Visual background ambient glow */}
      <div style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: "800px",
        height: "800px",
        borderRadius: "50%",
        background: "radial-gradient(circle, rgba(174, 147, 87, 0.04) 0%, rgba(0, 0, 0, 0) 70%)",
        pointerEvents: "none",
        zIndex: 0
      }} />

      <motion.div 
        initial={{ opacity: 0, y: 25 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}
        className="grid-symmetrical-4"
        style={{ 
          width: "100%", 
          maxWidth: "960px", 
          zIndex: 1, 
          position: "relative",
          alignItems: "center",
          gap: "48px"
        }}
      >
        {/* Column 1: Identity Card Visualization */}
        <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <span style={{ fontSize: "11px", letterSpacing: "0.15em", color: "var(--color-golden-accent)", fontWeight: 700 }}>COGNITIVE IDENTITY CARD</span>
            <h1 className="serif-display" style={{ fontSize: "36px", margin: 0, fontWeight: 400, lineHeight: 1.15 }}>
              Your Memory <span className="gradient-gold-text">Gateway</span>
            </h1>
            <p style={{ color: "var(--color-stone-text)", fontSize: "14px", lineHeight: 1.5, margin: 0 }}>
              Establish a secure cognitive interface to bridge persistent local files, rules, and vector search spaces to your active AI agents.
            </p>
          </div>

          {/* The Visual Identity Card */}
          <motion.div
            onMouseMove={handleMouseMove}
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={handleMouseLeave}
            style={{
              width: "100%",
              maxWidth: "420px",
              aspectRatio: "1.586", // standard credit card ratio
              background: "var(--color-pewter-accent)",
              border: "1px solid var(--border-med)",
              borderRadius: "16px",
              padding: "24px",
              boxShadow: isHovered 
                ? "var(--card-shadow-hover)"
                : "var(--card-shadow)",
              position: "relative",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              overflow: "hidden",
              backdropFilter: "blur(16px)",
              transform: `perspective(1000px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
              transition: isHovered 
                ? "transform 0.05s linear, box-shadow 0.3s ease" 
                : "transform 0.5s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease",
              transformStyle: "preserve-3d",
              cursor: "pointer"
            }}
          >
            {/* Subtle gold grid background element */}
            <div style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundImage: "radial-gradient(rgba(174, 147, 87, 0.08) 1px, transparent 0)",
              backgroundSize: "20px 20px",
              opacity: 0.5,
              zIndex: 0,
              pointerEvents: "none"
            }} />

            {/* Cursor-tracking light beam spotlight */}
            <div style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: `radial-gradient(180px circle at ${coords.x}px ${coords.y}px, rgba(255, 240, 204, 0.12) 0%, rgba(174, 147, 87, 0.04) 50%, transparent 100%)`,
              opacity: isHovered ? 1 : 0,
              transition: "opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
              pointerEvents: "none",
              zIndex: 2
            }} />

            {/* Top Line */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", zIndex: 1 }}>
              {/* Golden Chip */}
              <div style={{
                width: "44px",
                height: "32px",
                borderRadius: "6px",
                background: "linear-gradient(135deg, #ae9357 0%, #ffd88a 50%, #ae9357 100%)",
                border: "1px solid rgba(255,255,255,0.1)",
                position: "relative",
                boxShadow: "inset 0 1px 2px rgba(255,255,255,0.2), 0 4px 10px rgba(174, 147, 87, 0.2)"
              }}>
                {/* Chip grid lines */}
                <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: "1px", background: "var(--border-strong)" }} />
                <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: "1px", background: "var(--border-strong)" }} />
                <div style={{ position: "absolute", top: "25%", left: "20%", right: "20%", height: "50%", borderLeft: "1px solid var(--border-strong)", borderRight: "1px solid var(--border-strong)" }} />
              </div>

              {/* Pulsing Status Badge */}
              <div style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 12px",
                borderRadius: "var(--radius-pill)",
                background: "var(--overlay-bg)",
                border: "1px solid var(--border-dim)"
              }}>
                <span style={{
                  width: "6px",
                  height: "6px",
                  borderRadius: "50%",
                  background: loading ? "var(--color-stone-text)" : "var(--color-golden-accent)",
                  boxShadow: loading ? "none" : "0 0 8px var(--color-golden-accent)"
                }} />
                <span style={{ fontSize: "9px", fontWeight: 600, color: "var(--color-white-frost)", letterSpacing: "0.07em", textTransform: "uppercase" }}>
                  {loading ? "syncing" : "vault core active"}
                </span>
              </div>
            </div>

            {/* Middle Line (Card Number / Mock Key) */}
            <div style={{ zIndex: 1 }}>
              <div style={{ fontSize: "8px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600, textTransform: "uppercase", marginBottom: "4px" }}>
                Secure Client Token
              </div>
              <code style={{ 
                fontSize: "14px", 
                color: "var(--color-pure-white)", 
                letterSpacing: "0.05em", 
                wordBreak: "break-all",
                fontFamily: "var(--font-inter)" 
              }}>
                br_••••••••••••••••••••••••
              </code>
            </div>

            {/* Bottom Line */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", zIndex: 1 }}>
              <div>
                <div style={{ fontSize: "8px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600, textTransform: "uppercase", marginBottom: "2px" }}>
                  Vault Owner
                </div>
                <div style={{ fontSize: "13px", color: "var(--color-white-frost)", fontWeight: 500, fontFamily: "var(--font-inter)" }}>
                  {mode === "signin" 
                    ? (signin.email ? signin.email.split("@")[0].toUpperCase() : "CHIP OWNER") 
                    : (signup.displayName ? signup.displayName.toUpperCase() : "CHIP OWNER")
                  }
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "8px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600, textTransform: "uppercase", marginBottom: "2px" }}>
                  Node Address
                </div>
                <div style={{ fontSize: "11px", color: "var(--color-golden-accent)", fontWeight: 600, fontFamily: "var(--font-inter)" }}>
                  {mode === "signin" ? (signin.email || "LOCAL-CORE-01") : (signup.email || "LOCAL-CORE-01")}
                </div>
              </div>
            </div>
          </motion.div>

          {/* Secure Details list */}
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {[
              { label: "Absolute Privacy", desc: "Protected by JWT cryptographic tunnels and local client vault structures." },
              { label: "Open Architecture", desc: "Direct integrations with Claude Desktop, Cursor, Next.js, and custom REST API bindings." }
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
                <div style={{
                  minWidth: "18px",
                  height: "18px",
                  borderRadius: "50%",
                  background: "var(--overlay-bg-hover)",
                  border: "1px solid var(--border-hover-accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--color-golden-accent)",
                  fontSize: "10px",
                  marginTop: "2px"
                }}>✓</div>
                <div>
                  <h4 style={{ margin: 0, fontSize: "13px", fontWeight: 600, color: "var(--color-pure-white)" }}>{item.label}</h4>
                  <p style={{ margin: "2px 0 0 0", fontSize: "12px", color: "var(--color-stone-text)", lineHeight: 1.4 }}>{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Column 2: Auth Form Panel */}
        <div 
          className="card-premium" 
          style={{ 
            width: "100%", 
            padding: "40px",
            display: "flex",
            flexDirection: "column",
            gap: "24px"
          }}
        >
          {/* Brand Header */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "6px" }}>
            <h2 className="serif-display" style={{ fontSize: "28px", margin: 0, fontWeight: 400, letterSpacing: "-0.01em" }}>
              Brain<span className="gradient-gold-text">Router</span>
            </h2>
            <p style={{ color: "var(--color-stone-text)", fontSize: "13px", margin: 0 }}>
              Access your persistent cognitive context vault
            </p>
          </div>

          {/* Tab Controls (Segmented Controller) */}
          <div style={{
            display: "flex",
            background: "var(--overlay-bg)",
            padding: "4px",
            borderRadius: "var(--radius-pill)",
            border: "1px solid var(--border-dim)",
            position: "relative",
            width: "100%"
          }}>
            <button 
              type="button" 
              onClick={() => { setMode("signin"); setError(""); }} 
              style={{ 
                flex: 1, 
                padding: "10px 0", 
                borderRadius: "var(--radius-pill)", 
                fontSize: "13px", 
                fontWeight: 600, 
                color: mode === "signin" ? "var(--color-pure-white)" : "var(--color-stone-text)", 
                background: "transparent", 
                border: "none", 
                cursor: "pointer", 
                zIndex: 1, 
                transition: "color 0.25s ease" 
              }}
            >
              Sign In
            </button>
            <button 
              type="button" 
              onClick={() => { setMode("signup"); setError(""); }} 
              style={{ 
                flex: 1, 
                padding: "10px 0", 
                borderRadius: "var(--radius-pill)", 
                fontSize: "13px", 
                fontWeight: 600, 
                color: mode === "signup" ? "var(--color-pure-white)" : "var(--color-stone-text)", 
                background: "transparent", 
                border: "none", 
                cursor: "pointer", 
                zIndex: 1, 
                transition: "color 0.25s ease" 
              }}
            >
              Sign Up
            </button>
            <motion.div
              style={{
                position: "absolute",
                top: "4px",
                bottom: "4px",
                left: mode === "signin" ? "4px" : "calc(50% + 2px)",
                width: "calc(50% - 6px)",
                background: "var(--overlay-bg-hover)",
                border: "1px solid var(--border-hover-accent)",
                borderRadius: "var(--radius-pill)",
              }}
              animate={{ left: mode === "signin" ? "4px" : "calc(50% + 2px)" }}
              transition={{ type: "spring", stiffness: 350, damping: 28 }}
            />
          </div>

          {/* Auth Forms */}
          <AnimatePresence mode="wait">
            {mode === "signin" ? (
              <motion.form 
                key="signin" 
                initial={{ opacity: 0, x: -10 }} 
                animate={{ opacity: 1, x: 0 }} 
                exit={{ opacity: 0, x: 10 }} 
                onSubmit={handleSignIn} 
                style={{ display: "flex", flexDirection: "column", gap: "18px" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>EMAIL ADDRESS</label>
                  <input 
                    className="pill-input" 
                    type="email"
                    placeholder="name@company.com" 
                    value={signin.email} 
                    required
                    onChange={(e) => setSignin((s) => ({ ...s, email: e.target.value }))} 
                  />
                </div>

                <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--color-silver-text)", fontSize: "13px", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    style={{ accentColor: "#cc9166" }}
                  />
                  Remember me
                </label>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>PASSWORD</label>
                  <input 
                    className="pill-input" 
                    type="password" 
                    placeholder="••••••••" 
                    value={signin.password} 
                    required
                    onChange={(e) => setSignin((s) => ({ ...s, password: e.target.value }))} 
                  />
                </div>

                {signup.password && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    <div style={{ height: "4px", borderRadius: "9999px", background: "rgba(226,227,233,0.12)", overflow: "hidden" }}>
                      <div
                        style={{
                          width: passwordStrength(signup.password).width,
                          height: "100%",
                          background: passwordStrength(signup.password).color,
                          transition: "width 160ms ease, background 160ms ease",
                        }}
                      />
                    </div>
                    <span style={{ color: passwordStrength(signup.password).color, fontSize: "11px", fontWeight: 600 }}>
                      {passwordStrength(signup.password).label} password
                    </span>
                  </div>
                )}

                {error && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ 
                      padding: "10px 14px", 
                      borderRadius: "var(--radius-md)", 
                      background: "rgba(239, 68, 68, 0.08)", 
                      border: "1px solid rgba(239, 68, 68, 0.2)",
                      color: "#f87171",
                      fontSize: "13px"
                    }}
                  >
                    {error}
                  </motion.div>
                )}

                <PremiumButton 
                  disabled={loading} 
                  variant="primary"
                  type="submit"
                  style={{ width: "100%", padding: "12px 0", borderRadius: "var(--radius-pill)", fontSize: "14px", fontWeight: 600, marginTop: "6px" }}
                >
                  {loading ? "Signing in..." : "Sign In to Console"}
                </PremiumButton>
              </motion.form>
            ) : (
              <motion.form 
                key="signup" 
                initial={{ opacity: 0, x: 10 }} 
                animate={{ opacity: 1, x: 0 }} 
                exit={{ opacity: 0, x: -10 }} 
                onSubmit={handleSignUp} 
                style={{ display: "flex", flexDirection: "column", gap: "18px" }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>EMAIL ADDRESS</label>
                  <input 
                    className="pill-input" 
                    type="email"
                    placeholder="name@company.com" 
                    value={signup.email} 
                    required
                    onChange={(e) => setSignup((s) => ({ ...s, email: e.target.value }))} 
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>DISPLAY NAME</label>
                  <input 
                    className="pill-input" 
                    placeholder="Your Name" 
                    value={signup.displayName} 
                    required
                    onChange={(e) => setSignup((s) => ({ ...s, displayName: e.target.value }))} 
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>CHOOSE PASSWORD</label>
                  <input 
                    className="pill-input" 
                    type="password" 
                    placeholder="••••••••" 
                    value={signup.password} 
                    required
                    onChange={(e) => setSignup((s) => ({ ...s, password: e.target.value }))} 
                  />
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  <label style={{ fontSize: "11px", letterSpacing: "0.08em", color: "var(--color-stone-text)", fontWeight: 600 }}>CONFIRM PASSWORD</label>
                  <input 
                    className="pill-input" 
                    type="password" 
                    placeholder="••••••••" 
                    value={signup.confirmPassword} 
                    required
                    onChange={(e) => setSignup((s) => ({ ...s, confirmPassword: e.target.value }))} 
                  />
                </div>

                {error && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    style={{ 
                      padding: "10px 14px", 
                      borderRadius: "var(--radius-md)", 
                      background: "rgba(239, 68, 68, 0.08)", 
                      border: "1px solid rgba(239, 68, 68, 0.2)",
                      color: "#f87171",
                      fontSize: "13px"
                    }}
                  >
                    {error}
                  </motion.div>
                )}

                <PremiumButton 
                  disabled={loading} 
                  variant="primary"
                  type="submit"
                  style={{ width: "100%", padding: "12px 0", borderRadius: "var(--radius-pill)", fontSize: "14px", fontWeight: 600, marginTop: "6px" }}
                >
                  {loading ? "Creating account..." : "Register Context Vault"}
                </PremiumButton>
              </motion.form>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
