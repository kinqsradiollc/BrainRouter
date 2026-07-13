"use client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
export default function ChatPage(){return <AuthGuard><div className="settings-page"><PageHeader title="Chat" description="Security-aware conversations will be available here."/><EmptyState title="Chat is ready for a connected agent" description="Use the desktop app to start an agent session while this shared web surface is wired up."/></div></AuthGuard>;}
