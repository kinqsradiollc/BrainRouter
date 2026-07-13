import React from 'react';
import { Alert, FlatList, Pressable, SafeAreaView, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { RelayClient } from './src/client/RelayClient';
import { SecureCredentialStore } from './src/storage/credentials';
import type { HostCredential, RelayEvent } from './src/protocol/types';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });

type Run = { id: string; task: string; status: string; candidates: Candidate[] };
type Candidate = { id: string; adapterId: string; status: string; changedFiles: number; rank?: number; score?: number };
type Tab = 'hosts' | 'terminal' | 'pair';

export default function App(): React.ReactElement {
  const store = React.useMemo(() => new SecureCredentialStore(), []);
  const client = React.useMemo(() => new RelayClient(store), [store]);
  const [hosts, setHosts] = React.useState<HostCredential[]>([]);
  const [activeHost, setActiveHost] = React.useState<string>();
  const [connection, setConnection] = React.useState('disconnected');
  const [runs, setRuns] = React.useState<Run[]>([]);
  const [candidate, setCandidate] = React.useState<Candidate>();
  const [terminal, setTerminal] = React.useState('');
  const [followup, setFollowup] = React.useState('');
  const [tab, setTab] = React.useState<Tab>('hosts');
  const [voice, setVoice] = React.useState(false);
  const [manualCode, setManualCode] = React.useState('');
  const [pairing, setPairing] = React.useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanLock = React.useRef(false);
  const voiceRef = React.useRef(false);

  React.useEffect(() => { voiceRef.current = voice; }, [voice]);

  const refreshHosts = React.useCallback(() => { void store.list().then(setHosts); }, [store]);
  React.useEffect(() => {
    refreshHosts();
    void Notifications.requestPermissionsAsync();
    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'connection') { setConnection(event.state); return; }
      const relay = event as RelayEvent;
      if (relay.event === 'status.changed' && Array.isArray(relay.status)) setRuns(relay.status as Run[]);
      if (relay.event === 'terminal.output' && typeof relay.chunk === 'string') setTerminal((current) => `${current}${relay.chunk}`.slice(-40_000));
      if (relay.event === 'agent.completed') {
        const body = `Candidate ${String(relay.candidateId)} ${String(relay.status)}.`;
        void Notifications.scheduleNotificationAsync({ content: { title: 'BrainRouter agent finished', body }, trigger: null });
        if (voiceRef.current) Speech.speak(body);
      }
    });
    return () => { unsubscribe(); client.close(); };
  }, [client, refreshHosts]);

  const connect = async (host: HostCredential): Promise<void> => {
    try {
      await client.connect(host.id); setActiveHost(host.id);
      setRuns(await client.rpc<Run[]>('fanout.list'));
    } catch (error) { Alert.alert('Could not connect', (error as Error).message); }
  };

  const pair = async (raw: string): Promise<void> => {
    if (pairing || scanLock.current) return;
    scanLock.current = true; setPairing(true);
    try {
      const host = await client.pair(raw, 'BrainRouter Desktop');
      refreshHosts(); setManualCode(''); setTab('hosts');
      await connect(host);
    } catch (error) { Alert.alert('Pairing failed', (error as Error).message); }
    finally { setPairing(false); setTimeout(() => { scanLock.current = false; }, 1_000); }
  };

  const selectCandidate = async (next: Candidate): Promise<void> => {
    try {
      if (!await client.acquireFloor(next.id)) { Alert.alert('Terminal busy', 'Another paired device currently holds the input floor.'); return; }
      setCandidate(next); setTerminal(''); setTab('terminal');
      const snapshot = await client.rpc<{ snapshot?: string }>('terminal.snapshot', { candidateId: next.id });
      setTerminal(snapshot?.snapshot ?? '');
      await client.subscribeTerminal(next.id);
    } catch (error) { Alert.alert('Terminal unavailable', (error as Error).message); }
  };

  const action = async (kind: 'followup' | 'interrupt' | 'approve'): Promise<void> => {
    if (!candidate) return;
    try { await client.control(candidate.id, kind, kind === 'followup' ? followup : undefined); if (kind === 'followup') setFollowup(''); }
    catch (error) { Alert.alert('Action failed', (error as Error).message); }
  };

  const PairView = (): React.ReactElement => (
    <View style={styles.screen}>
      <Text style={styles.title}>Pair this phone</Text>
      <Text style={styles.muted}>Start Mobile steering in Desktop, then scan its one-time encrypted QR code.</Text>
      {!cameraPermission?.granted ? <Pressable style={styles.primary} onPress={() => void requestCameraPermission()}><Text style={styles.primaryText}>Allow camera</Text></Pressable> : (
        <CameraView style={styles.camera} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={({ data }) => void pair(data)} />
      )}
      <Text style={styles.label}>Simulator or manual code</Text>
      <TextInput style={[styles.input, styles.codeInput]} multiline value={manualCode} onChangeText={setManualCode} placeholder="Paste pairing payload" placeholderTextColor="#6d6d76" />
      <Pressable disabled={!manualCode.trim() || pairing} style={[styles.primary, (!manualCode.trim() || pairing) && styles.disabled]} onPress={() => void pair(manualCode)}><Text style={styles.primaryText}>{pairing ? 'Pairing…' : 'Pair securely'}</Text></Pressable>
    </View>
  );

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}><View><Text style={styles.brand}>BR</Text></View><View style={{ flex: 1 }}><Text style={styles.headerTitle}>BrainRouter</Text><Text style={styles.muted}>{connection}</Text></View><View style={styles.voice}><Text style={styles.muted}>Voice</Text><Switch value={voice} onValueChange={setVoice} /></View></View>
      <View style={styles.tabs}>{(['hosts', 'terminal', 'pair'] as Tab[]).map((item) => <Pressable key={item} onPress={() => setTab(item)} style={[styles.tab, tab === item && styles.tabActive]}><Text style={[styles.tabText, tab === item && styles.tabTextActive]}>{item === 'hosts' ? 'Hosts' : item === 'terminal' ? 'Terminal' : 'Pair'}</Text></Pressable>)}</View>
      {tab === 'pair' ? <PairView /> : tab === 'terminal' ? (
        <View style={styles.screen}>
          <View style={styles.rowBetween}><View><Text style={styles.title}>{candidate?.adapterId ?? 'No candidate selected'}</Text><Text style={styles.muted}>{candidate?.status ?? 'Choose a candidate from Hosts'}</Text></View></View>
          <ScrollView style={styles.terminal}><Text selectable style={styles.terminalText}>{terminal || 'Waiting for terminal output…'}</Text></ScrollView>
          <View style={styles.composer}><TextInput style={[styles.input, { flex: 1 }]} value={followup} onChangeText={setFollowup} placeholder="Follow-up" placeholderTextColor="#6d6d76" /><Pressable style={styles.smallButton} onPress={() => void action('followup')}><Text style={styles.buttonText}>Send</Text></Pressable></View>
          <View style={styles.actions}><Pressable style={styles.smallButton} onPress={() => void action('approve')}><Text style={styles.buttonText}>Approve</Text></Pressable><Pressable style={styles.dangerButton} onPress={() => void action('interrupt')}><Text style={styles.buttonText}>Interrupt</Text></Pressable></View>
        </View>
      ) : (
        <FlatList style={styles.screen} contentContainerStyle={{ gap: 10, paddingBottom: 24 }} data={hosts} keyExtractor={(host) => host.id} ListHeaderComponent={<><View style={styles.rowBetween}><Text style={styles.title}>Paired hosts</Text><Pressable style={styles.smallButton} onPress={() => setTab('pair')}><Text style={styles.buttonText}>Pair</Text></Pressable></View>{hosts.length === 0 ? <Text style={styles.empty}>No desktop is paired yet.</Text> : null}</>} renderItem={({ item: host }) => <View style={styles.card}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.cardTitle}>{host.name}</Text><Text style={styles.muted}>{host.endpoints[0]}</Text><Text style={styles.scope}>{host.scopes.join(' · ')}</Text></View><Pressable style={styles.smallButton} onPress={() => void connect(host)}><Text style={styles.buttonText}>{activeHost === host.id ? 'Refresh' : 'Connect'}</Text></Pressable></View>{activeHost === host.id ? runs.map((run) => <View key={run.id} style={styles.run}><Text style={styles.cardTitle}>{run.task}</Text><Text style={styles.muted}>{run.status}</Text>{run.candidates.map((item) => <Pressable key={item.id} style={styles.candidate} onPress={() => void selectCandidate(item)}><View><Text style={styles.cardTitle}>{item.adapterId}</Text><Text style={styles.muted}>{item.status} · {item.changedFiles} files</Text></View>{item.rank ? <Text style={styles.rank}>#{item.rank}</Text> : <Text style={styles.chevron}>›</Text>}</Pressable>)}</View>) : null}</View>} />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#09090b' },
  header: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#27272a' },
  brand: { width: 34, height: 34, textAlign: 'center', lineHeight: 34, borderRadius: 9, overflow: 'hidden', backgroundColor: '#1c1c20', color: '#f5f5f7', fontWeight: '800' },
  headerTitle: { color: '#f5f5f7', fontWeight: '700', fontSize: 16 },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabs: { flexDirection: 'row', padding: 8, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#27272a' },
  tab: { flex: 1, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 8 }, tabActive: { backgroundColor: '#202024' },
  tabText: { color: '#85858f', fontWeight: '600' }, tabTextActive: { color: '#f5f5f7' },
  screen: { flex: 1, padding: 14 }, title: { color: '#f5f5f7', fontSize: 18, fontWeight: '700' }, muted: { color: '#92929c', fontSize: 12 },
  label: { color: '#c5c5cc', fontSize: 12, fontWeight: '600', marginTop: 12 },
  primary: { height: 44, backgroundColor: '#7167f5', alignItems: 'center', justifyContent: 'center', borderRadius: 9, marginTop: 12 }, primaryText: { color: 'white', fontWeight: '700' }, disabled: { opacity: 0.45 },
  camera: { height: 330, borderRadius: 12, overflow: 'hidden', marginTop: 14 },
  input: { height: 42, borderRadius: 8, borderWidth: 1, borderColor: '#303036', backgroundColor: '#121216', color: '#f5f5f7', paddingHorizontal: 10 }, codeInput: { minHeight: 90, height: 90, paddingTop: 10, marginTop: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  card: { borderWidth: 1, borderColor: '#27272a', backgroundColor: '#111114', borderRadius: 11, padding: 12, gap: 10 }, cardTitle: { color: '#ececef', fontWeight: '600', fontSize: 13 }, scope: { color: '#7167f5', fontSize: 11, marginTop: 3 },
  smallButton: { minHeight: 34, minWidth: 66, paddingHorizontal: 11, borderRadius: 8, borderWidth: 1, borderColor: '#38383f', alignItems: 'center', justifyContent: 'center' }, dangerButton: { minHeight: 34, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: '#8d3434', alignItems: 'center', justifyContent: 'center' }, buttonText: { color: '#eeeeF2', fontWeight: '600', fontSize: 12 },
  run: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2b2b30', paddingTop: 9, gap: 7 }, candidate: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 8, backgroundColor: '#18181c', padding: 9 }, rank: { color: '#4eca7a', fontWeight: '700' }, chevron: { color: '#777780', fontSize: 22 }, empty: { color: '#73737d', paddingVertical: 26, textAlign: 'center' },
  terminal: { flex: 1, borderWidth: 1, borderColor: '#27272a', borderRadius: 10, backgroundColor: '#050506', marginVertical: 10, padding: 10 }, terminalText: { color: '#d5d5da', fontFamily: 'monospace', fontSize: 11, lineHeight: 16 }, composer: { flexDirection: 'row', gap: 7 }, actions: { flexDirection: 'row', gap: 7, marginTop: 8, justifyContent: 'flex-end' },
});
