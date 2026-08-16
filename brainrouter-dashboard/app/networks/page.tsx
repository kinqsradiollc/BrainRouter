"use client";
import Link from "next/link";
import { AuthGuard } from "../../components/AuthGuard";
import { PageHeader } from "../../components/PageHeader";
import { EmptyState } from "../../components/EmptyState";
/** Network inventory is derived from authorized targets, so the empty state's
 *  job is to send someone to the page where a target is authorized — this
 *  surface never fills on its own. */
export default function NetworksPage(){return <AuthGuard><div className="settings-page"><PageHeader title="Networks" description="What an assessment can see, for targets you authorized."/><EmptyState title="No network inventory yet" description="Network discovery stays inside the targets someone has authorized. Authorize a domain or API first, and what it reaches shows up here."><Link href="/domains">Authorize a target</Link></EmptyState></div></AuthGuard>;}
