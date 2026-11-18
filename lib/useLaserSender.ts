'use client';

/**
 * Sender side: owns the outgoing queue and the link to the Uno.
 *
 *   usb   browser -> Web Serial -> Uno          (works on https and localhost)
 *   wifi  browser -> HTTP -> NodeMCU -> Uno     (http pages only, mixed content)
 *
 * The laser is a one-message-at-a-time medium and a short message occupies it
 * for the better part of twenty seconds, so messages are queued here and
 * released one by one rather than fired at the Uno, whose 64 byte serial
 * buffer would otherwise overflow.
 *
 * Every message starts with a beacon: a slow blink that gives the person
 * holding the phone time to aim, and gives the receiver something
 * unmistakably blinking to lock onto.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { SerialLink, serialSupported } from './serial';
import {
  DEFAULT_BEACON_MS,
  buildFrame,
  effectiveBeaconMs,
  frameDurationMs,
} from './protocol';

export type Transport = 'usb' | 'wifi';
export type Phase = 'idle' | 'beacon' | 'data';

export type Outgoing = {
  id: number;
  at: number;
  text: string;
  state: 'queued' | 'sending' | 'sent' | 'failed';
  totalMs: number;
  beaconMs: number;
  startedAt?: number;
  error?: string;
};

export type LogLine = { t: number; kind: 'tx' | 'rx' | 'sys' | 'err'; text: string };

/** Quiet gap after a frame so the idle period is unambiguous. */
const INTER_MESSAGE_MS = 800;

export function useLaserSender(bitMs: number) {
  const linkRef = useRef<SerialLink | null>(null);
  const queueRef = useRef<Outgoing[]>([]);
  const busyRef = useRef(false);
  const idRef = useRef(1);
  const timerRef = useRef<number | null>(null);

  const [transport, setTransport] = useState<Transport>('usb');
  const [nodeIp, setNodeIp] = useState('192.168.4.1');
  const [beaconMs, setBeaconMsState] = useState(DEFAULT_BEACON_MS);
  const [connected, setConnected] = useState(false);
  const [supported, setSupported] = useState(true);
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [active, setActive] = useState<{ startedAt: number; totalMs: number; beaconMs: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setSupported(serialSupported()), []);

  const log = useCallback((kind: LogLine['kind'], text: string) => {
    setLines((prev) => [...prev.slice(-250), { t: Date.now(), kind, text }]);
  }, []);

  // One ticker drives every countdown and progress bar on screen.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(id);
  }, [active]);

  const sync = useCallback(() => setOutgoing([...queueRef.current]), []);

  const patch = useCallback(
    (id: number, next: Partial<Outgoing>) => {
      const item = queueRef.current.find((q) => q.id === id);
      if (item) Object.assign(item, next);
      sync();
    },
    [sync],
  );

  /* ------------------------------------------------------------ transports */

  const connectUsb = useCallback(async () => {
    try {
      const link = new SerialLink();
      link.onLine = (l) => {
        const trimmed = l.trim();
        if (trimmed) log('rx', trimmed);
      };
      link.onStatus = (ok, detail) => {
        setConnected(ok);
        log(ok ? 'sys' : 'err', ok ? 'Port open (' + detail + ')' : 'Port closed: ' + detail);
      };
      await link.connect(9600);
      linkRef.current = link;
    } catch (err) {
      log('err', String(err instanceof Error ? err.message : err));
    }
  }, [log]);

  const disconnectUsb = useCallback(async () => {
    await linkRef.current?.disconnect();
    linkRef.current = null;
    setConnected(false);
  }, []);

  const writeLine = useCallback(
    async (text: string) => {
      if (transport === 'usb') {
        const link = linkRef.current;
        if (!link?.connected) throw new Error('USB not connected');
        await link.sendLine(text);
        return;
      }
      const url = 'http://' + nodeIp + '/api/send?msg=' + encodeURIComponent(text);
      const res = await fetch(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('NodeMCU replied ' + res.status);
    },
    [transport, nodeIp],
  );

  const sendCommand = useCallback(
    async (text: string) => {
      try {
        await writeLine(text);
        log('tx', text);
      } catch (err) {
        log('err', String(err instanceof Error ? err.message : err));
      }
    },
    [log, writeLine],
  );

  const setBeaconMs = useCallback(
    (ms: number) => {
      setBeaconMsState(ms);
      void sendCommand('#BEACON=' + ms);
    },
    [sendCommand],
  );

  /* ---------------------------------------------------------------- queue */

  const pump = useCallback(() => {
    if (busyRef.current) return;
    const next = queueRef.current.find((q) => q.state === 'queued');
    if (!next) return;

    busyRef.current = true;
    const startedAt = Date.now();
    patch(next.id, { state: 'sending', startedAt });
    setActive({ startedAt, totalMs: next.totalMs, beaconMs: next.beaconMs });
    setNow(startedAt);

    writeLine(next.text)
      .then(() => {
        log('tx', next.text);
        timerRef.current = window.setTimeout(() => {
          patch(next.id, { state: 'sent' });
          busyRef.current = false;
          setActive(null);
          pump();
        }, next.totalMs + INTER_MESSAGE_MS);
      })
      .catch((err) => {
        const msg = String(err instanceof Error ? err.message : err);
        patch(next.id, { state: 'failed', error: msg });
        log('err', msg);
        busyRef.current = false;
        setActive(null);
        pump();
      });
  }, [log, patch, writeLine]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim().toUpperCase().slice(0, 60);
      if (!text) return;
      const item: Outgoing = {
        id: idRef.current++,
        at: Date.now(),
        text,
        state: 'queued',
        totalMs: frameDurationMs(buildFrame(text), bitMs, beaconMs),
        beaconMs: effectiveBeaconMs(beaconMs),
      };
      queueRef.current = [...queueRef.current, item].slice(-60);
      sync();
      pump();
    },
    [beaconMs, bitMs, pump, sync],
  );

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const clearQueue = useCallback(() => {
    queueRef.current = queueRef.current.filter((q) => q.state === 'sending');
    sync();
  }, [sync]);

  /* --------------------------------------------------------------- derived */

  const elapsed = active ? now - active.startedAt : 0;
  const sending = active !== null && elapsed < active.totalMs;
  const phase: Phase = !sending ? 'idle' : elapsed < active!.beaconMs ? 'beacon' : 'data';
  const beaconLeftMs = active ? Math.max(0, active.beaconMs - elapsed) : 0;
  const totalLeftMs = active ? Math.max(0, active.totalMs - elapsed) : 0;
  const progressPct = active ? Math.min(100, (elapsed / active.totalMs) * 100) : 0;
  const pending = outgoing.filter((o) => o.state === 'queued').length;

  /**
   * An https page cannot reach a plain http NodeMCU; the browser blocks it as
   * mixed content. Only the localhost dev server can use the Wi-Fi transport.
   */
  const wifiBlocked =
    typeof window !== 'undefined' && window.location.protocol === 'https:' && transport === 'wifi';

  const ready = transport === 'usb' ? connected : !wifiBlocked;

  return {
    transport,
    setTransport,
    nodeIp,
    setNodeIp,
    beaconMs,
    setBeaconMs,
    connected,
    supported,
    ready,
    wifiBlocked,
    outgoing,
    lines,
    sending,
    phase,
    beaconLeftMs,
    totalLeftMs,
    progressPct,
    pending,
    connectUsb,
    disconnectUsb,
    send,
    sendCommand,
    clearQueue,
  };
}
