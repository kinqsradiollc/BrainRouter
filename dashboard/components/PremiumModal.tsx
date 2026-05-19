import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { PremiumButton } from "./PremiumButton";

interface PremiumModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function PremiumModal({ isOpen, onClose, title, children }: PremiumModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          {/* Backdrop Blur Layer */}
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: "rgba(0, 0, 0, 0.7)",
              backdropFilter: "blur(8px)"
            }}
          />

          {/* Modal Container */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            className="card card-premium"
            style={{
              width: "100%",
              maxWidth: "540px",
              position: "relative",
              zIndex: 101,
              padding: "32px",
              display: "flex",
              flexDirection: "column",
              gap: "20px",
              background: "linear-gradient(135deg, rgba(20, 21, 26, 0.95) 0%, rgba(8, 9, 12, 0.98) 100%)",
              border: "1px solid rgba(174, 147, 87, 0.2)",
              boxShadow: "0 40px 80px rgba(0, 0, 0, 0.8), 0 0 40px rgba(174, 147, 87, 0.08)"
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 className="serif-display" style={{ fontSize: "22px", margin: 0, color: "var(--color-golden-accent)", fontWeight: 500 }}>
                {title}
              </h3>
              <PremiumButton 
                variant="text" 
                style={{ padding: "4px 8px", minWidth: "auto" }} 
                onClick={onClose}
              >
                ✕
              </PremiumButton>
            </div>

            {/* Content */}
            <div style={{ color: "var(--color-porcelain-text)", fontSize: "14px", lineHeight: 1.6 }}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
