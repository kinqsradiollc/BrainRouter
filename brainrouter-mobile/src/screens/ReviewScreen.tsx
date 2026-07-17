/**
 * ReviewScreen (S-11/S-12) — the PR-style local review inbox. Shows the review
 * gate banner (clean vs blocked) and a card per finding: severity, file:line,
 * prose, and a real mini-diff rendered from the ported `domain/view/reviewCode`
 * `findingRows` (add=accent, del/problem=danger) — not prose. Triage actions and
 * re-run wire up in a later slice.
 */
import React, { useEffect, useState } from 'react';
import { Text, View, StyleSheet, ScrollView } from 'react-native';
import { Screen, EmptyState } from '../components/primitives/Screen';
import { useTheme } from '../theme/ThemeProvider';
import { useTransport } from '../state/TransportProvider';
import { Icon } from '../components/Icon';
import { MONO } from '../theme/fonts';
import { findingRows, type CodeRow } from '../domain/view/reviewCode';

interface Finding {
  id: string;
  file: string;
  line?: number;
  endLine?: number;
  severity: string;
  title: string;
  body?: string;
  diffHunk?: string;
  codeExcerpt?: string;
  suggestion?: string;
}
interface Gate {
  status: string;
  blocked: boolean;
  reason: string;
}
interface ReviewCurrent {
  run: { id: string; findings: Finding[] } | null;
  gate: Gate | null;
  files: number;
}

function CodeLine({ row }: { row: CodeRow }): React.JSX.Element {
  const theme = useTheme();
  const isAdd = row.kind === 'add';
  const isDel = row.kind === 'del' || row.kind === 'problem';
  const bg = isAdd ? theme.colors.accentWash : isDel ? 'rgba(229,103,95,0.12)' : 'transparent';
  const color = isAdd ? theme.colors.accent : isDel ? theme.colors.danger : row.kind === 'meta' ? theme.colors.muted : theme.colors.text2;
  const prefix = isAdd ? '+' : row.kind === 'del' ? '−' : row.kind === 'meta' ? '' : ' ';
  return (
    <Text style={{ backgroundColor: bg, color, fontFamily: MONO, fontSize: 11.5, lineHeight: 17 }}>
      {prefix}
      {row.text}
    </Text>
  );
}

function FindingCard({ finding }: { finding: Finding }): React.JSX.Element {
  const theme = useTheme();
  const rows = findingRows(finding);
  const sevColor = finding.severity === 'error' ? theme.colors.danger : finding.severity === 'warn' ? theme.colors.warn : theme.colors.text2;
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.raised, borderColor: theme.colors.border, borderRadius: theme.radius.card }]}>
      <View style={styles.head}>
        <View style={[styles.sevDot, { backgroundColor: sevColor }]} />
        <Text style={{ color: theme.colors.text, fontSize: 13.5, fontWeight: '600', flex: 1 }}>{finding.title}</Text>
      </View>
      <Text style={{ color: theme.colors.muted, fontSize: 11, fontFamily: MONO, marginBottom: 6 }}>
        {finding.file}
        {finding.line != null ? `:${finding.line}` : ''}
      </Text>
      {finding.body ? <Text style={{ color: theme.colors.text2, fontSize: 12.5, lineHeight: 18 }}>{finding.body}</Text> : null}
      {rows.length > 0 ? (
        <View style={[styles.code, { backgroundColor: theme.colors.base, borderColor: theme.colors.border }]}>
          {rows.map((r, i) => (
            <CodeLine key={i} row={r} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ReviewScreen(): React.JSX.Element {
  const theme = useTheme();
  const transport = useTransport();
  const [data, setData] = useState<ReviewCurrent | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const rc = await transport.query<ReviewCurrent>('review-current');
      if (alive) setData(rc ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const findings = data?.run?.findings ?? [];
  const gate = data?.gate ?? null;

  return (
    <Screen title="Review" subtitle={data ? `${findings.length} findings` : undefined}>
      <View style={{ gap: theme.spacing.sm }}>
        {data === null ? (
          <EmptyState title="Loading…" />
        ) : (
          <>
            {gate ? (
              <View
                style={[
                  styles.gate,
                  {
                    backgroundColor: gate.blocked ? theme.colors.raised : theme.colors.accentWash,
                    borderColor: gate.blocked ? theme.colors.warn : theme.colors.accentLine,
                    borderRadius: theme.radius.card,
                  },
                ]}
              >
                <Icon name={gate.blocked ? 'warn' : 'check-circle'} size={18} color={gate.blocked ? theme.colors.warn : theme.colors.accent} />
                <Text style={{ color: theme.colors.text, fontSize: 13, flex: 1 }}>{gate.reason}</Text>
              </View>
            ) : null}
            {findings.length === 0 ? (
              <EmptyState title="No findings" detail="The last review found nothing to triage." />
            ) : (
              findings.map((f) => <FindingCard key={f.id} finding={f} />)
            )}
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  gate: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderLeftWidth: 2 },
  card: { padding: 12, borderWidth: StyleSheet.hairlineWidth, gap: 2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },
  sevDot: { width: 8, height: 8, borderRadius: 4 },
  code: { marginTop: 8, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6 },
});
