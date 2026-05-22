"use client";

import { motion } from "framer-motion";

interface StatCardProps {
  title: string;
  value: string | number;
}

export function StatCard({ title, value }: StatCardProps) {
  return (
    <motion.div
      className="card"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ 
        y: -4, 
        borderColor: "rgba(204, 145, 102, 0.3)",
        boxShadow: "0 12px 30px rgba(0, 0, 0, 0.6), 0 0 15px rgba(204, 145, 102, 0.05)"
      }}
      transition={{ 
        type: "spring", 
        stiffness: 260, 
        damping: 20 
      }}
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        minHeight: "110px",
        position: "relative"
      }}
    >
      {/* Spotlight Border Indicator */}
      <div 
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "30px",
          height: "1px",
          background: "var(--color-golden-accent)",
          opacity: 0.7
        }} 
      />

      <div style={{ color: "var(--color-stone-text)", fontSize: "13px", fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {title}
      </div>

      <motion.div 
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 300, damping: 15 }}
        style={{ 
          color: "var(--color-pure-white)", 
          fontSize: "32px", 
          fontWeight: 600, 
          marginTop: "12px",
          letterSpacing: "-0.03em",
          lineHeight: 1
        }}
      >
        {value}
      </motion.div>
    </motion.div>
  );
}
