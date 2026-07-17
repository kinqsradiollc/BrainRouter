/**
 * PlanScreen (S-06) — the agent's plan for the session + its approval state.
 * Reuses the ported, tested `domain/view/planReviewView` (approval state +
 * label). Steps render with a status dot (pending / in-progress / completed);
 * the banner reflects approved / changes-requested / revised / not-reviewed.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { ListScreen } from '../components/primitives/ListScreen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { planApprovalState, approvalLabel, type PlanDecisionView } from '../domain/view/planReviewView';
import type { PlanItem } from '../types';

interface PlanState {
  items: PlanItem[];
  explanation?: string;
}

export function PlanScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [plan, setPlan] = useState<PlanState | null>(null);
  const [decisions, setDecisions] = useState<PlanDecisionView[]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const p = await transport.query<PlanState>('plan-state');
      const h = await transport.query<PlanDecisionView[]>('plan-history');
      if (!alive) return;
      setPlan(p ?? null);
      setDecisions(h ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const items = plan?.items ?? [];
  const state = planApprovalState(items.length ? { items } : null, decisions);
  const bannerColor = state.kind === 'approved' ? theme.colors.accent : state.kind === 'none' ? theme.colors.text2 : theme.colors.warn;

  return (
    <ListScreen loading={plan === null} isEmpty={items.length === 0} emptyTitle="No plan" emptyDetail="The agent's plan for this session appears here.">
      <View style={[styles.banner, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
        <Icon name={state.kind === 'approved' ? 'check-circle' : state.kind === 'none' ? 'plan' : 'warn'} size={18} color={bannerColor} />
        <Text style={[styles.bannerText, { color: theme.colors.text }]}>{approvalLabel(state)}</Text>
      </View>
      {plan?.explanation ? <Text style={[styles.expl, { color: theme.colors.text2 }]}>{plan.explanation}</Text> : null}
      {items.map((it, i) => {
        const done = it.status === 'completed';
        const active = it.status === 'in_progress';
        const dot = done ? theme.colors.accent : active ? theme.colors.warn : theme.colors.muted;
        return (
          <View key={`${it.step}-${i}`} style={[styles.step, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
            <View style={[styles.dot, { backgroundColor: dot }]} />
            <Text style={[styles.stepText, { color: done ? theme.colors.muted : theme.colors.text, textDecorationLine: done ? 'line-through' : 'none' }]}>
              {it.step}
            </Text>
          </View>
        );
      })}
    </ListScreen>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  bannerText: { fontSize: 13.5, fontWeight: '600' },
  expl: { fontSize: 12.5, lineHeight: 18, marginTop: 2, marginBottom: 2 },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth },
  dot: { width: 8, height: 8, borderRadius: 4 },
  stepText: { flex: 1, fontSize: 14, lineHeight: 19 },
});
