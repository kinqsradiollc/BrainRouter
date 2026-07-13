"use client";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
export default function NetworksPage(){return <AuthGuard><div className="settings-page"><PageHeader title="Networks" description="Network visibility will appear here for authorized assessments."/><EmptyState title="No network inventory" description="Add a domain or API target first; network discovery remains scoped to your authorized targets."/></div></AuthGuard>;}
